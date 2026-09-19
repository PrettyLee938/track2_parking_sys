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

/** How a car from an entrance gets to a zone: the entry gates it drives through, in order,
 * and the entry sensors it passes on the way (their events are not new arrivals). */
export interface RouteDef {
  gates: string[];
  sensors: string[];
}

export interface Topology {
  name: string;
  entry_lanes: LaneDef[];
  exit_lanes: LaneDef[];
  /** entry sensor -> zone -> route. A zone missing here cannot be reached from that entrance.
   * Absent altogether: each entrance reaches only its own zone, through its own gate. */
  routes?: Record<string, Record<string, RouteDef>>;
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
interface LevelPoint { Name: string; X: number; Y: number }
interface LevelPath { Points?: LevelPoint[]; Connections?: { From: string; To: string; Direction?: number }[] }

/** A gate or sensor this close (sim units) to a route's road is on the route. Level 2: every
 * route passes its gates at 92-100; the nearest gate NOT on a route is 450 away. */
const ON_ROUTE_DISTANCE = 150;

/**
 * Routes from every entrance to every zone, from the level's road network (Paths).
 * 2026-09-20: Level 2 is one road down the west side, with gate1, gate3 and gate5 across it
 * in series, each zone branching off after its gate. A car from ENTRY1 reaches ZONE2 through
 * gate1 AND gate3 (passing the ENTRY2 sensor) - sent there with only gate1 open, it never
 * moved.
 *
 * Connection Direction (undocumented): 0 = From->To only, 1 = To->From only, 2 = both ways.
 * Of the readings tried on Level 2 it is the only one where every entrance reaches its own
 * zone and every zone its own exit (and entrances reach only the zones further down the road).
 */
export function routesFromLevel(level: { Paths?: LevelPath[]; ParkingSpots?: LevelSpot[] }, t: Topology): Topology["routes"] {
  const points = new Map<string, LevelPoint>();
  const next = new Map<string, string[]>();
  const link = (a: string, b: string) => (next.get(a) ?? next.set(a, []).get(a)!).push(b);
  for (const p of level.Paths ?? []) {
    for (const pt of p.Points ?? []) points.set(pt.Name, pt);
    for (const c of p.Connections ?? []) {
      if (c.Direction !== 1) link(c.From, c.To);
      if (c.Direction === 1 || c.Direction === 2) link(c.To, c.From);
    }
  }
  if (!points.size) return undefined;
  const spots = level.ParkingSpots ?? [];
  const at = (name: string) => spots.find((s) => s.Name === name);
  const nearest = (o: { X: number; Y: number }) =>
    [...points.values()].reduce((b, p) => (Math.hypot(p.X - o.X, p.Y - o.Y) < Math.hypot(b.X - o.X, b.Y - o.Y) ? p : b));
  const route = (from: string, to: string): LevelPoint[] | null => {
    const prev = new Map<string, string | null>([[from, null]]), queue = [from];
    while (queue.length) {
      const n = queue.shift()!;
      if (n === to) break;
      for (const m of next.get(n) ?? []) if (!prev.has(m)) { prev.set(m, n); queue.push(m); }
    }
    if (!prev.has(to)) return null;
    const out: LevelPoint[] = [];
    for (let n: string | null = to; n; n = prev.get(n) ?? null) out.unshift(points.get(n)!);
    return out;
  };
  // Where along the route (segment index) something is, or null if it is not on it.
  const along = (r: LevelPoint[], o: { X: number; Y: number }): number | null => {
    let best: { i: number; d: number } | null = null;
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i], dx = b.X - a.X, dy = b.Y - a.Y, len = dx * dx + dy * dy;
      const k = len ? Math.max(0, Math.min(1, ((o.X - a.X) * dx + (o.Y - a.Y) * dy) / len)) : 0;
      const d = Math.hypot(o.X - (a.X + k * dx), o.Y - (a.Y + k * dy));
      if (!best || d < best.d) best = { i: i - 1 + k, d };
    }
    return best && best.d <= ON_ROUTE_DISTANCE ? best.i : null;
  };
  const gatePos = new Map<string, LevelGate>(((level as { Gates?: LevelGate[] }).Gates ?? []).map((g) => [g.Name, g]));
  const entryGates = t.entry_lanes.map((l) => l.gate).filter((g): g is string => !!g && gatePos.has(g));
  const zones = new Map<string, LevelSpot>(); // one parking spot per zone as the destination
  for (const s of spots) if (s.Purpose === SpotPurpose.Park && s.ZoneParent && !zones.has(s.ZoneParent)) zones.set(s.ZoneParent, s);

  const routes: Record<string, Record<string, RouteDef>> = {};
  for (const lane of t.entry_lanes) {
    const sensor = at(lane.spot);
    if (!sensor) continue;
    routes[lane.spot] = {};
    for (const [zone, spot] of zones) {
      const r = route(nearest(sensor).Name, nearest(spot).Name);
      if (!r) continue;
      const gates = entryGates.map((g) => ({ name: g, pos: along(r, gatePos.get(g)!) }))
        .filter((g) => g.pos !== null).sort((a, b) => a.pos! - b.pos!).map((g) => g.name); // in driving order
      const sensors = t.entry_lanes.map((l) => at(l.spot)).filter((s): s is LevelSpot => !!s && along(r, s) !== null).map((s) => s.Name);
      routes[lane.spot][zone] = { gates, sensors };
    }
  }
  return routes;
}

/** Routes for t from the matching level file in dir (same entry/exit sensors), if any. */
export function routesFromLevelsDir(dir: string, t: Topology, log: Logger = quiet): Topology["routes"] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^lvl.*\.json$/.test(f)).sort();
  } catch {
    return undefined;
  }
  for (const f of files) {
    try {
      const level = JSON.parse(readFileSync(path.join(dir, f), "utf8").replace(/^﻿/, ""));
      const sensors = (level.ParkingSpots ?? []) as LevelSpot[];
      const set = (purpose: string) => new Set(sensors.filter((s) => s.Purpose === purpose).map((s) => s.Name));
      if (!matches(t, set(SpotPurpose.Entry), set(SpotPurpose.Exit))) continue;
      const routes = routesFromLevel(level, t);
      if (routes) log.info(`routes from ${f}: ${Object.entries(routes).map(([e, z]) =>
        `${e} -> ${Object.entries(z).map(([zone, r]) => `${zone} via ${r.gates.join("+") || "no gate"}`).join(", ")}`).join("; ")}`);
      return routes;
    } catch (e) {
      log.error(`cannot read routes from ${f}: ${(e as Error).message}`);
    }
  }
  return undefined;
}

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
      if (!t.routes && opts.simLevelsDir) {
        const routes = routesFromLevelsDir(opts.simLevelsDir, t, log);
        if (routes) return { ...t, routes };
      }
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
