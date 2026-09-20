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
  // Which webhooks are acted on. Every one is stored either way, with its signature status
  // (valid / unsigned / invalid), so rejected calls stay visible.
  //   strict  - only correctly signed ones (Level 2+: "respond only to signed webhooks")
  //   lenient - signed or unsigned, never a wrong signature (Level 1 sends Signature=null)
  //   monitor - all of them, status only recorded: to check how a new level signs
  //             (npm run report:level -w server) before switching to strict
  signatureMode: z.enum(["strict", "lenient", "monitor"]).default("strict"),
  /** Profile used by the route layer to apply Level 2 ingress policy automatically. */
  levelProfile: z.enum(["auto", "level1", "level2", "level3"]).default("auto"),
  /** Level 2 webhooks are expected to arrive from the local simulator process. */
  webhookLoopbackOnly: bool().default(false),

  // ---- webhook ingress security (Level 3, see webhook.ts) --------------------
  // Duplicate and tampered detection is durable: event_identities holds the payload hash
  // of the first delivery of every EventId, so it survives a restart. This cache only
  // saves the lookup for ids seen since startup; it is never the authority.
  webhookDedupeCacheSize: num().int().min(0).default(5000),
  // Replay protection. A delivery whose ServerDateTime is more than this many seconds
  // from our clock is recorded and refused. 0 = off, which is the default: ServerDateTime
  // is the simulator machine's wall clock, so a clock that disagrees with ours would
  // otherwise reject every event. Turn it on (300 is sensible) once you have seen from
  // `report:level` that the two clocks agree.
  webhookReplayWindowS: num().nonnegative().default(0),
  // Per-source ceiling on deliveries. 0 = off (the default): three Level 3 car emitters
  // burst legitimately, and throttling the simulator loses events we would rather queue.
  // Set it only to protect against something that is not the simulator.
  webhookRatePerSourcePerS: num().nonnegative().default(0),
  // How far above the per-second rate a genuine burst may go before it is refused.
  webhookRateBurst: num().int().min(1).default(200),

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
  // zone_balanced: extra cost of a zone whose exit gate is broken/under repair, and of one
  // whose exit gate is worn (x uses/limit) - spreading cars spreads the exit-gate wear.
  zoneExitDownCost: num().nonnegative().default(1),
  zoneExitWearCost: num().nonnegative().default(0.3),
  // ...and of each extra gate on the way to a zone further down the road (ENTRY1 -> ZONE2
  // also opens gate3): a gate cycle of wear and a longer drive.
  zoneRouteGateCost: num().nonnegative().default(0.15),
  // A car on its way down the road holds the gates it still has to pass open for at most this
  // long (GAME seconds) - the drive takes seconds; longer means its parking event was lost.
  transitMaxGameS: num().positive().default(60),

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
  // Each "should be charged at the exit" penalty adds 0.5 game-s to that exit's delay, up to this.
  exitChargeDelayMaxExtraGameS: num().nonnegative().default(3),
  // How long after a car clears the entry/exit sensor its gate is closed: enough for the
  // car to pass the barrier, short enough that nobody else follows. Cars leave the exit
  // ~1.5 game-s after paying and arrive every ~8 game-s.
  gateCloseDelayGameS: num().nonnegative().default(1.5),
  // Entry gates stay open this long after the last car went in. Cars never drive through an
  // entry without a goto (7,124 entries checked), and every closing costs a gate cycle -
  // Level 2 gates break after 10 - so an entry keeps its gate open across a stream of cars.
  entryGateCloseDelayGameS: num().nonnegative().default(10),
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
  // Before writing off overdue parked cars, the simulator is asked (list-parking-spots, at most
  // this often, GAME seconds) whether their spots are really empty.
  parkedCheckGameS: num().positive().default(60),
  // Any other car (driving to or waiting at an exit) with no event for this long.
  staleCarGameS: num().positive().default(600),

  // ---- component health (Level 2, components.ts) -----------------------------------
  // Repair a broken gate, spot or fan as soon as nothing is using it.
  autoRepair: bool().default(true),
  // After a rejected repair command, wait this long (GAME seconds) before trying again.
  repairRetryGameS: num().positive().default(10),
  // Repair parts before they break (a breakdown = fine + a long outage). A part is repaired
  // when one more use would break it, or - when nothing needs it right now - once it has
  // used this share of its limit. Limits are learned from breakdowns (gates: 10 openings)
  // unless set here (0 = learn).
  preventiveMaintenance: bool().default(true),
  preventiveIdleRatio: num().min(0).max(1).default(0.8),
  // A spot is only repaired early (before it is due) while its zone keeps more free spots than this.
  spotRepairMinFree: num().int().min(0).default(3),
  // A worn-out gate is not opened until repaired. If no repair has started after this long
  // (GAME seconds) while cars wait, it is opened anyway: a breakdown beats a dead lane.
  wornWaitMaxGameS: num().positive().default(20),
  // Known Level 2 simulator limits. Keep 0 available when a deployment must
  // learn a site-specific limit from its breakdown events.
  gateCycleLimit: num().int().min(0).default(10),
  spotUseLimit: num().int().min(0).default(12),
  fanHourLimit: num().min(0).default(0),

  // ---- environment (Level 2, environment.ts) ----------------------------------------
  // A zone's exhaust fans run while its CO is at/above coFanOnLevel and stop once it is below
  // coFanOffLevel (spec: "turn off when CO levels are below 50"). The level is read with
  // list-zones every coPollGameS while there is traffic or a fan runs: the simulator sent no
  // CO webhook at all in the 2026-09-20 runs, only CO penalties.
  fanControl: bool().default(true),
  coFanOnLevel: num().nonnegative().default(50),
  coFanOffLevel: num().nonnegative().default(40),
  coPollGameS: num().positive().default(15),

  // Lights (spec: they guide drivers in dark zones, cost electricity, "make sure they run
  // only at night", "no need to be on if all cars are parking, they must be on if a car is
  // moving in the zone"). A zone's lights follow the cars moving in it, not its occupancy:
  // a full car park with nobody driving needs no light, and one car moving through an empty
  // one does.
  lightControl: bool().default(true),
  // auto = only between nightStartHour and nightEndHour; always = ignore the clock (still
  // only while cars move); never = leave every light alone, for manual control.
  // NOTE no event carries the simulator's time of day - ServerDateTime is the wall clock -
  // so "night" is this configured window read off the latest event's hour. If a future
  // level exposes a real day/night field, drive it from that instead.
  lightsMode: z.enum(["auto", "always", "never"]).default("auto"),
  nightStartHour: num().min(0).max(24).default(18),
  nightEndHour: num().min(0).max(24).default(6),
  // route = light only what a car is using: the middle aisle it drives along, plus the bay
  // light over its own row while it parks (needs the level file for light positions).
  // group = one command per zone, all ten lights together - fewer commands, more burning.
  lightsDetail: z.enum(["route", "group"]).default("route"),
  // Keep a light on this long after the last car needed it, so a stream of cars does not
  // flicker it off and on between them.
  lightsHoldGameS: num().min(0).default(20),
  // Nothing has moved anywhere in the car park for this long: switch every light off,
  // whatever else thinks. Catches a light left on by a command that was dropped, or by a
  // car record that never closed.
  lightsIdleOffGameS: num().min(0).default(300),

  // ---- payments --------------------------------------------------------------------
  // A payment_made with a bad signature is a fake: the car has not paid. It is never
  // released for it; ask it to pay once more (the only way it can still pay).
  rechargeAfterFakePayment: bool().default(true),
  // How many times to ask again after fake payments (2026-09-20: some cars faked twice).
  fakePaymentRecharges: num().int().min(0).default(3),

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
