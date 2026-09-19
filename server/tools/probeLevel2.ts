/**
 * Level 2 discovery: asks the simulator what it actually exposes, and answers the
 * questions the Level 2 brief leaves open before any of it is designed around.
 *
 *   - lights and exhaust fans: what fields do they carry? (name, zone, state, broken,
 *     usage counters?) Nothing in the codebase knows their shape yet.
 *   - is there a day/night or ambient-light field anywhere? The brief says lights
 *     should not run in simulator daytime, but webhook ServerDateTime is wall-clock,
 *     so the in-world hour has to come from somewhere else - or be configured.
 *   - do any components report usage cycles or wear, or must we count them ourselves?
 *   - which zone does each gate serve, and what is the gate that sits on no lane?
 *
 * Read-only: it sends no commands. Run with the simulator on a Level 2 map:
 *     npm run probe:lvl2 -w server
 * The full raw response lands in data/probe-lvl2.json to diff against later runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cfg, resolveSite, sim } from "./site";

type Row = Record<string, unknown>;

/** Calls an endpoint that may not exist on this level, without taking the run down. */
async function probe<T>(label: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (ex) {
    console.log(`  ${label}: unavailable (${(ex as Error).message.split("\n")[0].slice(0, 120)})`);
    return null;
  }
}

/** Every field name seen across the rows, with an example value for each. */
function shapeOf(rows: Row[]): Array<[string, string]> {
  const seen = new Map<string, string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (!seen.has(k)) seen.set(k, `${JSON.stringify(v)} (${Array.isArray(v) ? "array" : typeof v})`);
    }
  }
  return [...seen].sort(([a], [b]) => a.localeCompare(b));
}

const asRows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : v ? [v as Row] : []);

/**
 * Field names split into words, so hints match whole words only. Matching plain
 * substrings makes "isUnderMaintenance" a hit for "sun".
 */
const words = (field: string): string[] =>
  field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());

/** Whole words that would answer the day/night question if the simulator has one. */
const TIME_HINTS = new Set(["day", "daytime", "daylight", "night", "nighttime", "hour", "hours",
  "time", "ambient", "sun", "sunlight", "dark", "darkness", "clock", "brightness", "illumination"]);
/** Whole words meaning usage cycles come for free instead of being counted by us. */
const WEAR_HINTS = new Set(["cycle", "cycles", "usage", "uses", "used", "count", "counter", "wear",
  "hours", "runtime", "uptime", "operations", "health", "lifetime", "age", "mileage"]);

function highlight(label: string, rows: Row[], hints: Set<string>): string[] {
  return shapeOf(rows)
    .filter(([k]) => words(k).some((w) => hints.has(w)))
    .map(([k, v]) => `${label}.${k} = ${v}`);
}

async function main() {
  console.log(`Probing ${cfg.simBaseUrl}\n`);
  const raw: Record<string, unknown> = {};

  const sections: Array<[string, () => Promise<unknown>]> = [
    ["zones", () => sim.listZones()],
    ["lights", () => sim.listLights()],
    ["exhaust fans", () => sim.listExhaustFans()],
    ["alarms", () => sim.listAlarms()],
    ["barriers", () => sim.listBarriers()],
    ["parking spots", () => sim.listParkingSpots()],
  ];

  const collected: Record<string, Row[]> = {};
  for (const [label, call] of sections) {
    const result = await probe(label, call);
    raw[label] = result;
    if (result === null) continue;
    const rows = asRows(result);
    collected[label] = rows;
    console.log(`${label}: ${rows.length} row(s)`);
    for (const [field, example] of shapeOf(rows)) console.log(`    ${field.padEnd(22)} e.g. ${example}`);
    console.log();
  }

  // ---- the questions this tool exists to answer -------------------------------
  console.log("=".repeat(72));

  const timeHits = Object.entries(collected).flatMap(([l, rows]) => highlight(l, rows, TIME_HINTS));
  console.log("\nDAY / NIGHT (brief: lights should not run in simulator daytime)");
  if (timeHits.length) {
    timeHits.forEach((h) => console.log(`  found  ${h}`));
    console.log("  -> drive the lights off this field rather than a configured window.");
  } else {
    console.log("  no day/night or ambient field on any endpoint.");
    console.log("  -> configure a game-hour window (GPA_DAYLIGHT_FROM/TO) on the game clock,");
    console.log("     or watch whether the simulator toggles lights by itself and follow it.");
  }

  const wearHits = Object.entries(collected).flatMap(([l, rows]) => highlight(l, rows, WEAR_HINTS));
  console.log("\nUSAGE CYCLES (brief: monitor usage cycles for maintenance scheduling)");
  if (wearHits.length) {
    wearHits.forEach((h) => console.log(`  found  ${h}`));
    console.log("  -> read wear from the simulator; no need to count it ourselves.");
  } else {
    console.log("  no cycle/usage/wear counter exposed.");
    console.log("  -> we must count cycles ourselves and persist them (a restart mid-run");
    console.log("     must not reset the wear clock that preventive maintenance reads).");
  }

  console.log("\nCONTROLLABLE COMPONENTS");
  for (const key of ["lights", "exhaust fans"]) {
    const rows = collected[key] ?? [];
    if (!rows.length) {
      console.log(`  ${key}: none reported - this level may have none, or the endpoint differs.`);
      continue;
    }
    const byZone = new Map<string, number>();
    for (const r of rows) {
      const zone = String(r.zoneParent ?? r.zone ?? r.ZoneName ?? "?");
      byZone.set(zone, (byZone.get(zone) ?? 0) + 1);
    }
    console.log(`  ${key}: ${rows.length} across ${byZone.size} zone(s) - ` +
      [...byZone].map(([z, n]) => `${z}:${n}`).join(", "));
  }

  // ---- topology: the unassigned gate ------------------------------------------
  console.log("\nTOPOLOGY");
  const site = await probe("resolve", () => resolveSite());
  if (site) {
    console.log(`  level '${site.name}': ${site.entry_lanes.length} entry, ${site.exit_lanes.length} exit lane(s)`);
    for (const l of site.entry_lanes) console.log(`    in   ${l.spot.padEnd(12)} -> ${String(l.gate ?? "-").padEnd(8)} zone ${l.zone}`);
    for (const l of site.exit_lanes) console.log(`    out  ${l.spot.padEnd(12)} -> ${String(l.gate ?? "-").padEnd(8)} zone ${l.zone}`);
    const loose = (site.notes?.gates_not_on_a_lane as string[] | undefined) ?? [];
    if (loose.length) {
      const barriers = collected["barriers"] ?? [];
      console.log(`  gates on no lane: ${loose.join(", ")}`);
      for (const name of loose) {
        const b = barriers.find((x) => x.name === name);
        console.log(`    ${name}: zone ${b?.zoneParent ?? "?"}, state ${b?.state ?? "?"}` +
          `${b?.broken ? ", BROKEN" : ""}`);
      }
      console.log("  -> the brief says parking areas are enclosed. If one of these separates");
      console.log("     two zones, a car allocated across that boundary stalls unless it opens.");
      console.log("     Confirm by watching whether cars ever queue at it during a run.");
    } else {
      console.log("  every gate belongs to a lane.");
    }
  }

  // ---- spots by zone and car type ---------------------------------------------
  const spots = collected["parking spots"] ?? [];
  const parkSpots = spots.filter((s) => String(s.purpose) === "Park");
  if (parkSpots.length) {
    console.log("\nPARKING BY ZONE AND CAR TYPE");
    const grid = new Map<string, Map<string, number>>();
    for (const s of parkSpots) {
      const zone = String(s.zoneParent ?? "?"), type = String(s.parkingForCarType ?? "Any");
      const row = grid.get(zone) ?? new Map<string, number>();
      row.set(type, (row.get(type) ?? 0) + 1);
      grid.set(zone, row);
    }
    for (const [zone, row] of [...grid].sort()) {
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      console.log(`  ${zone.padEnd(10)} ${String(total).padStart(3)} spots  ` +
        [...row].sort().map(([t, n]) => `${t}:${n}`).join(", "));
    }
    const broken = spots.filter((s) => s.broken || s.isUnderMaintenance).length;
    if (broken) console.log(`  ${broken} spot(s) already broken or under maintenance`);
  }

  const out = path.resolve(cfg.dataDir, "probe-lvl2.json");
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(out, JSON.stringify(raw, null, 2));
  console.log(`\nRaw responses written to ${out}`);
}

main().catch((ex) => {
  console.error(ex);
  process.exit(1);
});
