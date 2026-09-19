/**
 * Site layout: which gate serves which entry/exit sensor, and which zone it leads to.
 *
 * The simulator API lists spots and gates but never says which gate belongs to which
 * entry/exit spot. That pairing lives in topology/*.json, one file per site (level).
 * At startup the controller lists the live entry/exit spots and picks the file whose
 * spot sets match exactly, so switching levels needs no code or config change.
 *
 * A topology file can be written by hand, or generated from the simulator's level
 * layouts with `npm run topology` (pairs each sensor with its nearest gate).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SpotPurpose, type SimBarrier, type SimParkingSpot } from "@gpa/shared";

export interface LaneDef {
  spot: string; //        entry/exit sensor name
  gate: string | null; // barrier the car passes; null = no barrier on this lane
  zone: string; //        zone this lane serves ("" = unknown)
}

export interface Topology {
  name: string;
  entry_lanes: LaneDef[];
  exit_lanes: LaneDef[];
  source?: string;
  notes?: Record<string, unknown>;
}

type Logger = { info(msg: string): void; error(msg: string): void };
const quiet: Logger = { info() {}, error() {} };

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function matches(t: Topology, entrySpots: Set<string>, exitSpots: Set<string>): boolean {
  return sameSet(new Set(t.entry_lanes.map((l) => l.spot)), entrySpots) &&
    sameSet(new Set(t.exit_lanes.map((l) => l.spot)), exitSpots);
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
export function loadDir(dir: string, log: Logger = quiet): Topology[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Topology[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(d.entry_lanes) || !Array.isArray(d.exit_lanes)) throw new Error("missing lanes");
      out.push({ ...d, source: file });
    } catch (e) {
      log.error(`ignoring bad topology file ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

interface LevelSpot { Name: string; Purpose: string; X: number; Y: number; ZoneParent?: string }
interface LevelGate { Name: string; X: number; Y: number; ZoneParent?: string }

/**
 * Pair every entry/exit sensor with its nearest gate using the level's coordinates.
 * Pairs are claimed closest-first so two sensors never share a gate.
 */
export function deriveFromLevelFile(file: string, maxGateDistance: number): Topology {
  const level = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const gates = new Map<string, LevelGate>((level.Gates ?? []).map((g: LevelGate) => [g.Name, g]));
  const sensors: LevelSpot[] = (level.ParkingSpots ?? []).filter(
    (s: LevelSpot) => s.Purpose === SpotPurpose.Entry || s.Purpose === SpotPurpose.Exit);

  const pairs = sensors
    .flatMap((s) => [...gates.values()].map((g) => ({ dist: Math.hypot(s.X - g.X, s.Y - g.Y), sensor: s.Name, gate: g.Name })))
    .sort((a, b) => a.dist - b.dist);
  const sensorGate = new Map<string, { gate: string; dist: number }>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (p.dist > maxGateDistance) break;
    if (sensorGate.has(p.sensor) || used.has(p.gate)) continue;
    sensorGate.set(p.sensor, { gate: p.gate, dist: p.dist });
    used.add(p.gate);
  }

  const entry: LaneDef[] = [], exit: LaneDef[] = [], distances: Record<string, number | null> = {};
  for (const s of sensors) {
    const pair = sensorGate.get(s.Name);
    const zone = s.ZoneParent || (pair ? gates.get(pair.gate)?.ZoneParent : "") || "";
    (s.Purpose === SpotPurpose.Entry ? entry : exit).push({ spot: s.Name, gate: pair?.gate ?? null, zone });
    distances[s.Name] = pair ? Math.round(pair.dist * 10) / 10 : null;
  }
  return {
    name: path.basename(file, ".json"),
    entry_lanes: entry,
    exit_lanes: exit,
    source: `derived:${file}`,
    notes: {
      generated_from: path.basename(file),
      gate_distance: distances,
      gates_not_on_a_lane: [...gates.keys()].filter((g) => !used.has(g)).sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// resolution against the live simulator
// ---------------------------------------------------------------------------
export interface ResolveOptions {
  topologyDir: string;
  simLevelsDir?: string;
  maxGateDistance: number;
  candidates?: Topology[];
  log?: Logger;
}

/**
 * Pick the topology matching the running level. Order: explicit candidates,
 * topologyDir files, then layouts derived from simLevelsDir. Falls back to gate-less
 * lanes (logged loudly) so the app still starts.
 */
export function resolve(liveSpots: SimParkingSpot[], liveGates: SimBarrier[], opts: ResolveOptions): Topology {
  const log = opts.log ?? quiet;
  const entry = new Set(liveSpots.filter((s) => s.purpose === SpotPurpose.Entry).map((s) => s.name));
  const exit = new Set(liveSpots.filter((s) => s.purpose === SpotPurpose.Exit).map((s) => s.name));
  const gateNames = new Set(liveGates.map((g) => g.name));

  const pools = [opts.candidates ?? [], loadDir(opts.topologyDir, log)];
  if (opts.simLevelsDir) pools.push(deriveAll(opts.simLevelsDir, opts.maxGateDistance, log));
  for (const pool of pools) {
    for (const t of pool) {
      if (!matches(t, entry, exit)) continue;
      const missing = [...t.entry_lanes, ...t.exit_lanes].map((l) => l.gate).filter((g): g is string => !!g && !gateNames.has(g));
      if (missing.length) {
        log.error(`topology ${t.name} names gates the simulator does not have: ${missing.join(", ")}`);
        continue;
      }
      log.info(`using topology ${t.name} (${t.source ?? "injected"})`);
      return t;
    }
  }

  log.error(`no topology matches entries=[${[...entry].sort()}] exits=[${[...exit].sort()}] - running WITHOUT gate ` +
    `control. Add a file to ${opts.topologyDir} (npm run topology) or set GPA_SIM_LEVELS_DIR.`);
  const zoneOf = new Map(liveSpots.map((s) => [s.name, s.zoneParent || ""]));
  const lane = (n: string): LaneDef => ({ spot: n, gate: null, zone: zoneOf.get(n) ?? "" });
  return { name: "unresolved", entry_lanes: [...entry].sort().map(lane), exit_lanes: [...exit].sort().map(lane), source: "fallback" };
}

function deriveAll(dir: string, maxGateDistance: number, log: Logger): Topology[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^lvl.*\.json$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: Topology[] = [];
  for (const f of files) {
    try {
      out.push(deriveFromLevelFile(path.join(dir, f), maxGateDistance));
    } catch (e) {
      log.error(`cannot derive topology from ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}
