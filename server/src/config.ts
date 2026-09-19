/**
 * Application settings.
 *
 * Resolution order (highest wins): environment variables > .env (repo root) > defaults.
 * Every variable is GPA_ + the field name in SCREAMING_SNAKE_CASE, e.g.
 * simBaseUrl -> GPA_SIM_BASE_URL. See .env.example for the full list.
 *
 * Site layout (which gate serves which entry/exit) is NOT configured here; it lives
 * in topology/*.json - see topology.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const num = () => z.coerce.number();
const bool = () => z.stringbool();
const repoPath = () => z.string().transform((p) => path.resolve(REPO_ROOT, p));

export const Rounding = { Planned: "planned", Round: "round", Ceil: "ceil" } as const;

const schema = z.object({
  // ---- simulator connection ------------------------------------------------
  // Use 127.0.0.1, not "localhost": on Windows "localhost" tries IPv6 first and
  // costs ~2s per request before falling back to IPv4.
  simBaseUrl: z.string().url().default("http://127.0.0.1:9898/api/v1"),
  simUser: z.string().default("admin"),
  simPassword: z.string().default("admin"),
  simTimeoutS: num().positive().default(5),

  // ---- this server ----------------------------------------------------------
  appHost: z.string().default("0.0.0.0"),
  appPort: num().int().positive().default(8000),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // ---- behaviour switches ---------------------------------------------------
  // false = passive listener (log events, send no commands). Use it with the
  // single-car tool, which drives cars by hand.
  controllerEnabled: bool().default(true),
  // Level 1 sends Signature=null. Turn on once a level signs its webhooks, so
  // unsigned events are dropped as untrusted.
  requireSignature: bool().default(false),
  // Safety net for the switch above: while no signature has ever verified, this many
  // failing events are still processed (and flagged) instead of dropped, so a wrong
  // guess about the signing scheme cannot silently kill a run. Spent budget is never
  // refilled, and the first valid signature ends grace immediately. 0 = strict.
  signatureGraceN: num().int().min(0).default(50),
  // When the active scheme fails, try the other known ones and adopt any that matches.
  // Only until a signature verifies; after that a bad signature is a bad signature.
  signatureAutodetect: bool().default(true),
  // Shared secret folded into the webhook hash, if the simulator signs with one.
  // Without it the digest proves integrity, not origin.
  webhookSecret: z.string().optional(),

  // ---- site layout ----------------------------------------------------------
  topologyDir: repoPath().default(path.resolve(REPO_ROOT, "topology")),
  // Optional: the simulator's settings folder (contains lvl*.json). When no topology
  // file matches the running level, gates are paired from these layouts.
  simLevelsDir: repoPath().optional(),
  // Max distance (sim units) between a sensor and the gate paired with it.
  topologyMaxGateDistance: num().positive().default(400),

  // ---- spot allocation ------------------------------------------------------
  // See allocation.ts for the available strategies.
  allocationStrategy: z.string().default("lane_zone_first_free"),

  // ---- billing (spec: 1 per minute, x2 if electric) -------------------------
  // "planned" matched the simulator's own expected amount in 14/14 rejected bills at
  // game speed 1.7, where measured clock time was 1.7x too short.
  billingRounding: z.enum(["planned", "round", "ceil"]).default("planned"),
  pricePerMinute: num().nonnegative().default(1),
  electricMultiplier: num().nonnegative().default(2),
  paymentTolerance: num().nonnegative().default(0.005),
  // When the simulator rejects a bill and states the correct amount, bill that amount
  // instead of leaving the car stuck on (and blocking) the exit.
  rechargeOnWrongAmount: bool().default(true),

  // ---- game clock (see gameClock.ts) ---------------------------------------------
  // The simulator runs GameSpeedMultiplier times faster than the wall clock; cars,
  // gates and sensors all move in game time. Every *GameS setting below is measured on a
  // game clock that runs at the current game speed, taken from (first that applies):
  //   1. gameSpeed, if set here - a fixed override
  //   2. gate timing, right after it detects a speed change (Shift+PgUp while running)
  //   3. learned from completed stays (planned game time / measured real time), once
  //      timeScaleMinSamples stays have been seen
  //   4. GameSpeedMultiplier in the simulator's settings.json (simSettingsFile)
  //   5. 1.0
  gameSpeed: num().positive().optional(),
  // Defaults to <simLevelsDir>/settings.json when simLevelsDir is set.
  simSettingsFile: repoPath().optional(),
  // Stays kept for the median. Small, so a speed change is followed within a few stays.
  timeScaleSamples: num().int().min(1).default(9),
  timeScaleMinSamples: num().int().min(1).default(3),
  // Gate movements per speed reading; a reading this far (0.25 = 25%) off the current speed
  // is a speed change. A gate move takes ~0.6 game-s at any speed.
  gateSpeedSamples: num().int().min(1).default(5),
  speedChangeThreshold: num().positive().default(0.25),
  // No webhook at all for this many REAL seconds: the game is paused (or on its menu) and
  // the game clock stops, so parked cars are not aged into "missed their exit".
  pauseAfterSilenceS: num().positive().default(20),

  // ---- simulator timing (GAME seconds: scaled by game speed) ------------------------
  // Charging the instant exit CarIn arrives is rejected ("Car should be charged at the
  // exit") - the sensor needs < 1s to settle. 1.5 was verified at speed 1.0.
  exitChargeDelayGameS: num().nonnegative().default(1.5),
  exitChargeRetryGameS: num().nonnegative().default(2),
  // How long after a car clears the entry/exit sensor its gate is closed: enough for the
  // car to pass the barrier, short enough that nobody else follows. Cars leave the exit
  // ~1.5 game-s after paying and arrive every ~8 game-s.
  gateCloseDelayGameS: num().nonnegative().default(1.5),
  // A gate normally reports Open/Closed ~0.6 game-s after the command. An open not
  // confirmed after this long is re-sent once, then assumed open; a close is re-sent.
  gateConfirmGameS: num().positive().default(3),
  // The simulator silently drops some goto commands (~15% of those sent while another
  // car's event fires): the car just sits on the entry or exit sensor, holding the lane and
  // its open gate. A car normally drives off within ~2 game-s; if it has not after this
  // long, the goto is re-sent - up to maxGotoResends times, then a stuck entry car is
  // given up on so the lane keeps moving.
  gotoConfirmGameS: num().positive().default(4),
  maxGotoResends: num().int().min(0).default(5),
  // Cars give up after ~5 game-minutes at an entry.
  entryPatienceGameS: num().positive().default(290),
  // Cars arrive every ~8 game-s. No webhook for this long usually means the simulator was
  // restarted or reloaded: re-read spots and gates on the next event.
  resyncAfterSilenceGameS: num().positive().default(30),
  // A plate that paid this recently and shows up at an exit again is the same session
  // looping (every ~2 game-minutes), not a new one: never bill it twice.
  repeatExitWindowGameS: num().nonnegative().default(600),

  // ---- lost webhooks (GAME seconds) -------------------------------------------------
  // Delivery is at-most-once (1 of 3,406 events lost in a Level 1 run) and a simulator
  // restart makes cars vanish silently. A car record whose closing event never arrives
  // is retired after these limits, so it cannot hold a spot, a lane or a gate forever.
  // A paid, released car normally leaves ~1 game-s later (its leavepark is re-sent every
  // gotoConfirmGameS if not). Until its exit CarOut arrives the exit gate is held open.
  releaseTimeoutGameS: num().positive().default(30),
  // A parked car normally leaves at its planned time; this much longer means we missed it.
  parkedOverstayGameS: num().positive().default(300),
  // Any other car (driving to or waiting at an exit) with no event for this long.
  staleCarGameS: num().positive().default(600),

  // ---- components: wear, maintenance, air and light (Level 2) -----------------------
  // Usage cycles since a component's last repair before preventive maintenance is due.
  // Set any of these to 0 to stop scheduling that kind. The defaults are deliberately
  // conservative guesses: no Level 2 run has shown yet how fast components actually wear,
  // so watch component_broken events and tighten them once real numbers exist.
  maintGateCycles: num().int().min(0).default(400),
  maintSpotCycles: num().int().min(0).default(120),
  maintDeviceCycles: num().int().min(0).default(200),
  // On-time (GAME seconds) for a light or fan before its service is due.
  maintDeviceRuntimeGameS: num().min(0).default(7200),
  // Elapsed time since a component's last repair before it is due, whatever its usage.
  // The simulator breaks components on usage, not age, so this is off by default - but
  // set it small (e.g. 60) to watch the whole maintenance loop run during a test, without
  // having to drive hundreds of gate cycles first. Real seconds, so a test is predictable
  // regardless of game speed. 0 disables.
  maintMaxAgeS: num().min(0).default(0),
  // Send preventive repairs at all. Off = track wear and show it, but never act.
  preventiveMaintenance: bool().default(true),
  // Repair a component as soon as the simulator reports it broken. Nothing it serves works
  // until it is fixed, and a broken entry gate stops that entrance entirely, so this is not
  // subject to the per-zone budget below: its capacity is already lost.
  autoRepairBroken: bool().default(true),
  // A repair command the simulator drops leaves the component broken forever. Re-send it
  // this often (GAME seconds) while it is still reported broken.
  repairRetryGameS: num().positive().default(30),
  // Never take more than this many components out of service at once in one zone: a
  // maintenance sweep must not cost a zone its capacity.
  maintMaxConcurrentPerZone: num().int().min(1).default(1),
  // Game seconds between maintenance sweeps.
  maintIntervalGameS: num().positive().default(60),

  // Carbon monoxide: ventilate at or above onPpm, stop below offPpm. The gap is
  // deliberate - one threshold makes the fans chatter, and each flip is a usage cycle.
  coOnPpm: num().nonnegative().default(5),
  coOffPpm: num().nonnegative().default(3),
  // Act on a "High"/"Danger" DangerLevel even when the number is below coOnPpm.
  coTrustDangerWord: bool().default(true),
  // The simulator sends carbon_monoxide_event only at Mid and above (~50), so below that
  // a webhook-only system is blind: a threshold under Mid can never fire, because nothing
  // reports the level. Polling GET /list-zones this often (GAME seconds) fills that gap,
  // and also recovers if a CO webhook is lost. 0 = off. The docs warn every list-* call
  // carries a simulated operational cost, so keep the interval generous - but an
  // unventilated zone is Penalty_ZonePollutedWithHighCO, so this is a poll worth paying for.
  //
  // On by default. The docs say to call list-* endpoints only at load or after a crash,
  // and that guidance is right for spots, barriers, lights and fans - those change only
  // when something breaks, and a webhook tells us when it does. Carbon monoxide is the
  // exception: it changes continuously, the only push notification arrives at Mid and
  // above, and an unventilated zone is Penalty_ZonePollutedWithHighCO. A threshold below
  // Mid cannot be honoured at all without reading the level, so the choice is to poll or
  // to have the setting quietly do nothing. Set 0 to turn it off and rely on webhooks.
  zonePollGameS: num().min(0).default(10),

  // Lights off during simulator daytime. No endpoint is known to report the in-world
  // hour, so the window is read off the ServerDateTime the simulator stamps on events.
  // Set lightsFollowDaylight=false to leave lights entirely alone.
  lightsFollowDaylight: bool().default(true),
  daylightFromHour: num().min(0).max(24).default(7),
  daylightToHour: num().min(0).max(24).default(19),

  // ---- our own timing (REAL seconds) ------------------------------------------------
  tickIntervalS: num().positive().default(0.5),
  maxChargeAttempts: num().int().min(1).default(3),
  // Close any open gate nobody is using when syncing (levels start with exit gates open).
  closeIdleGatesOnSync: bool().default(true),

  // ---- dashboard accounts ----------------------------------------------------------
  // On first start (no users yet) an admin account is created with this name. Its
  // password is GPA_ADMIN_PASSWORD, or - if unset - generated and printed once in the log.
  adminUsername: z.string().regex(/^[A-Za-z0-9_.-]{3,32}$/).default("admin"),
  // Any length is accepted here (a short one gets a startup warning); accounts created in
  // the dashboard need at least 8 characters.
  adminPassword: z.string().min(1).optional(),
  sessionTtlH: num().positive().default(12),
  // Throttle guessing: after this many failed logins a username is locked for a while.
  loginMaxFailures: num().int().min(1).default(5),
  loginLockoutS: num().positive().default(60),
  // Occupancy is sampled this often for the dashboard's time-series (kept in memory).
  statsSampleS: num().positive().default(10),
  statsSampleKeep: num().int().positive().default(720), // 2 hours at 10 s
  // How often the live stream pushes a fresh snapshot to connected dashboards.
  streamIntervalS: num().positive().default(1),

  // ---- storage & recovery ------------------------------------------------------
  dataDir: repoPath().default(path.resolve(REPO_ROOT, "data")),
  // On startup, rebuild car state by replaying our own event log over this window...
  replayWindowS: num().nonnegative().default(1800),
  // ...but only if the log is fresh. A bigger gap means we were down long enough that
  // the simulator was probably restarted, and replaying would resurrect stale cars.
  replayMaxGapS: num().nonnegative().default(120),

  // ---- in-memory history sizes (dashboard) -----------------------------------
  feedSize: num().int().positive().default(300),
  completedSessionsSize: num().int().positive().default(500),
  recentEventsSize: num().int().positive().default(300),
});

export type Settings = z.infer<typeof schema>;

export const envName = (key: string) => "GPA_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

// ---------------------------------------------------------------------------
// runtime-tunable settings
// ---------------------------------------------------------------------------
/**
 * The settings an admin may change from the dashboard while a run is going.
 *
 * Deliberately a short list. Anything that decides *how the park is operated* - when to
 * ventilate, when to light, when to service - is worth tuning live, because the right
 * value only becomes apparent from watching a run. Everything else (ports, credentials,
 * paths, timing the simulator itself imposes) stays in .env: changing it mid-run would
 * either do nothing or break the connection to the simulator.
 */
export interface Tunable {
  key: keyof Settings & string;
  label: string;
  group: "Ventilation" | "Lighting" | "Maintenance";
  type: "number" | "boolean";
  /** Unit shown next to the field. */
  unit?: string;
  /** Lowest value the dashboard field accepts. NOT the value itself. */

  inputMin?: number;
  /** Highest value the dashboard field accepts. NOT the value itself. */

  inputMax?: number;
  step?: number;
  help: string;
}

export const TUNABLES: Tunable[] = [
  { key: "coOnPpm", label: "Ventilate at", group: "Ventilation", type: "number", unit: "ppm", inputMin: 0, inputMax: 1000,
    help: "Start a zone's exhaust fans at or above this CO level. The simulator treats 50 as the medium threshold." },
  { key: "coOffPpm", label: "Stop below", group: "Ventilation", type: "number", unit: "ppm", inputMin: 0, inputMax: 1000,
    help: "Stop the fans only once CO falls below this. Keep it under the start level: with both equal the fans chatter on and off around the boundary, and every flip is a usage cycle." },
  { key: "zonePollGameS", label: "Poll zones every", group: "Ventilation", type: "number", unit: "game s", inputMin: 0, inputMax: 3600,
    help: "Read CO straight from the simulator this often. The simulator only SENDS a CO event at Mid (~50) and above, so without this a threshold below Mid can never fire - nothing reports the lower levels. 0 = off. Each poll has a simulated cost, so keep it generous." },
  { key: "coTrustDangerWord", label: "Trust the danger level", group: "Ventilation", type: "boolean",
    help: "Ventilate on a Mid/High/Critical DangerLevel even when the number is below the start level." },

  { key: "lightsFollowDaylight", label: "Lights follow daylight", group: "Lighting", type: "boolean",
    help: "Switch lights by the simulator's time of day. Off leaves them entirely to manual control." },
  { key: "daylightFromHour", label: "Day starts", group: "Lighting", type: "number", unit: "h", inputMin: 0, inputMax: 24, step: 0.5,
    help: "Simulator hour at which daylight begins and the lights go off." },
  { key: "daylightToHour", label: "Day ends", group: "Lighting", type: "number", unit: "h", inputMin: 0, inputMax: 24, step: 0.5,
    help: "Simulator hour at which night begins and the lights come on." },

  { key: "preventiveMaintenance", label: "Preventive maintenance", group: "Maintenance", type: "boolean",
    help: "Repair worn components before they break. Off still tracks and shows wear, but sends nothing." },
  { key: "autoRepairBroken", label: "Auto-repair broken", group: "Maintenance", type: "boolean",
    help: "Repair a component as soon as the simulator reports it broken, without waiting for an operator." },
  { key: "maintGateCycles", label: "Gate service interval", group: "Maintenance", type: "number", unit: "cycles", inputMin: 0,
    help: "Confirmed opens since a gate's last repair before it is due. 0 never schedules gates." },
  { key: "maintSpotCycles", label: "Spot service interval", group: "Maintenance", type: "number", unit: "cycles", inputMin: 0,
    help: "Cars parked since a spot's last repair before it is due. 0 never schedules spots." },
  { key: "maintDeviceCycles", label: "Light/fan switch interval", group: "Maintenance", type: "number", unit: "cycles", inputMin: 0,
    help: "On/off switches since a light or fan's last repair before it is due. 0 disables." },
  { key: "maintDeviceRuntimeGameS", label: "Light/fan running interval", group: "Maintenance", type: "number", unit: "game s", inputMin: 0,
    help: "On-time in game seconds since a light or fan's last repair before it is due. 0 disables." },
  { key: "maintMaxConcurrentPerZone", label: "Concurrent repairs per zone", group: "Maintenance", type: "number", inputMin: 1, inputMax: 20,
    help: "How many components we take out of service at once in one zone. Components already broken do not count." },
  { key: "maintIntervalGameS", label: "Check wear every", group: "Maintenance", type: "number", unit: "game s", inputMin: 1,
    help: "Game seconds between maintenance sweeps." },
  { key: "maintMaxAgeS", label: "Service by age", group: "Maintenance", type: "number", unit: "s", inputMin: 0,
    help: "Service every component this long after its last repair, whatever its usage. Real seconds. 0 = off (the simulator breaks things by usage, not age). Set it to 60 to watch the whole maintenance loop run during a test." },
];

/**
 * Tunables whose current value falls outside their own declared min/max.
 *
 * `min`/`max` bound what an admin may *type*, not the value itself, so a bound edited to
 * look like a value (max: 5 when the default is 50) leaves the setting above its own
 * ceiling - and then every settings save is rejected with a confusing message about a
 * field nobody touched. Checked at startup so that shows up immediately.
 */
export function outOfRangeTunables(cfg: Settings): string[] {
  const problems: string[] = [];
  for (const t of TUNABLES) {
    if (t.type !== "number") continue;
    const value = cfg[t.key] as number;
    if (t.inputMin !== undefined && value < t.inputMin) problems.push(`${envName(t.key)}=${value} is below its allowed minimum ${t.inputMin}`);
    if (t.inputMax !== undefined && value > t.inputMax) problems.push(`${envName(t.key)}=${value} is above its allowed maximum ${t.inputMax}`);
  }
  return problems;
}

export const TUNABLE_KEYS = new Set<string>(TUNABLES.map((t) => t.key));

/**
 * Validates a patch of tunable settings against the same schema the environment uses,
 * so a value typed into the dashboard cannot be looser than one set in .env.
 * Returns the coerced values, or the problems found.
 */
export function validateTunables(patch: Record<string, unknown>): { ok: true; values: Partial<Settings> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const spec = TUNABLES.find((t) => t.key === key);
    if (!spec) {
      errors.push(`${key} is not a runtime setting`);
      continue;
    }
    // The schema parses strings (it reads env vars), so feed it the same shape.
    const field = schema.shape[key as keyof typeof schema.shape];
    const parsed = field.safeParse(typeof raw === "boolean" ? String(raw) : String(raw));
    if (!parsed.success) {
      errors.push(`${spec.label}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      continue;
    }
    const value = parsed.data as number | boolean;
    if (spec.type === "number" && typeof value === "number") {
      if (spec.inputMin !== undefined && value < spec.inputMin) errors.push(`${spec.label}: must be at least ${spec.inputMin}`);
      if (spec.inputMax !== undefined && value > spec.inputMax) errors.push(`${spec.label}: must be at most ${spec.inputMax}`);
    }
    values[key] = value;
  }
  // Hysteresis only works one way round; equal values make the fans chatter.
  const on = (values.coOnPpm ?? undefined) as number | undefined;
  const off = (values.coOffPpm ?? undefined) as number | undefined;
  if (on !== undefined && off !== undefined && off > on) {
    errors.push("Stop below must not be higher than Ventilate at, or the fans would never stop");
  }
  return errors.length ? { ok: false, errors } : { ok: true, values: values as Partial<Settings> };
}

/** Settings from the environment (and repo-root .env), with typed overrides on top. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Settings> = {}): Settings {
  const raw: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[envName(key)];
    if (value !== undefined && value !== "") raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${envName(String(i.path[0]))}: ${i.message}`);
    throw new Error(`Invalid settings:\n  ${problems.join("\n  ")}`);
  }
  const cfg = { ...parsed.data, ...overrides };
  if (!cfg.simSettingsFile && cfg.simLevelsDir) cfg.simSettingsFile = path.join(cfg.simLevelsDir, "settings.json");
  return cfg;
}

/** GPA_* variables that match no setting - typos, or names from before a rename.
 * They would otherwise be silently ignored. */
export function unknownSettingVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const known = new Set(Object.keys(schema.shape).map(envName));
  return Object.keys(env).filter((k) => k.startsWith("GPA_") && !known.has(k)).sort();
}

/** GameSpeedMultiplier from the simulator's settings.json, or null if unavailable. */
export function readSimGameSpeed(file: string | undefined): number | null {
  if (!file || !existsSync(file)) return null;
  try {
    const speed = Number(JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")).GameSpeedMultiplier);
    return speed > 0 ? speed : null;
  } catch {
    return null;
  }
}

export function loadDotEnv(file = path.join(REPO_ROOT, ".env")) {
  if (existsSync(file)) process.loadEnvFile(file);
}
