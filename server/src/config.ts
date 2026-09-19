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

  // ---- game clock -------------------------------------------------------------
  // The simulator runs GameSpeedMultiplier times faster than the wall clock; cars,
  // gates and sensors all move in game time. Every *GameS timer below is converted to
  // real time with the current game speed, taken from (first that applies):
  //   1. gameSpeed, if set here - a fixed override
  //   2. learned from completed stays (planned game time / measured real time), once
  //      timeScaleMinSamples stays have been seen - follows Shift+PgUp changes live
  //   3. GameSpeedMultiplier in the simulator's settings.json (simSettingsFile)
  //   4. 1.0
  gameSpeed: num().positive().optional(),
  // Defaults to <simLevelsDir>/settings.json when simLevelsDir is set.
  simSettingsFile: repoPath().optional(),
  timeScaleSamples: num().int().min(1).default(30),
  timeScaleMinSamples: num().int().min(1).default(3),

  // ---- simulator timing (GAME seconds: scaled by game speed) ------------------------
  // Charging the instant exit CarIn arrives is rejected ("Car should be charged at the
  // exit") - the sensor needs < 1s to settle. 1.5 was verified at speed 1.0.
  exitChargeDelayGameS: num().nonnegative().default(1.5),
  exitChargeRetryGameS: num().nonnegative().default(2),
  // How long after a car clears the entry/exit sensor its gate is closed: enough for the
  // car to pass the barrier, short enough that nobody else follows. Cars leave the exit
  // ~1.5 game-s after paying and arrive every ~8 game-s.
  gateCloseDelayGameS: num().nonnegative().default(1.5),
  // The simulator sometimes never confirms a gate opening (normally ~0.5 game-s). After
  // this long the open command is re-sent once; after the same again, it is assumed open.
  gateOpenTimeoutGameS: num().positive().default(6),
  // A dispatched car normally leaves its entry within ~3 game-s. After this long its goto
  // is re-sent, then it is given up on so the lane keeps moving.
  entryDispatchTimeoutGameS: num().positive().default(30),
  // Cars give up after ~5 game-minutes at an entry.
  entryPatienceGameS: num().positive().default(290),
  // Cars arrive every ~8 game-s. No webhook for this long usually means the simulator was
  // restarted or reloaded: re-read spots and gates on the next event.
  resyncAfterSilenceGameS: num().positive().default(30),
  // A plate that paid this recently and shows up at an exit again is the same session
  // looping (every ~2 game-minutes), not a new one: never bill it twice.
  repeatExitWindowGameS: num().nonnegative().default(600),

  // ---- our own timing (REAL seconds) ------------------------------------------------
  tickIntervalS: num().positive().default(0.5),
  maxChargeAttempts: num().int().min(1).default(3),
  maxDispatchRetries: num().int().min(0).default(1),
  // Close any open gate nobody is using when syncing (levels start with exit gates open).
  closeIdleGatesOnSync: bool().default(true),

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
