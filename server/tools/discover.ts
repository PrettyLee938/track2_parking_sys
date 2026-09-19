/**
 * Snapshot everything the simulator can list about the loaded level - spots, gates,
 * lights, exhaust fans, alarms, zones (CO) - print a summary and save the raw answers to
 * data/discovery/. The list-* endpoints have a simulated cost: run this once per level.
 *   npm run discover -w server
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SimBarrier, SimParkingSpot } from "@gpa/shared";
import { cfg, sim } from "./site";

type Row = Record<string, unknown>;

const count = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
};
const table = (title: string, rows: [string, number][]) => {
  console.log(`\n${title}`);
  for (const [k, n] of rows) console.log(`  ${k.padEnd(44)} ${n}`);
};
/** Every field name seen, with one example value - new levels add fields. */
const fields = (title: string, xs: Row[]) => {
  const seen = new Map<string, unknown>();
  for (const x of xs) for (const [k, v] of Object.entries(x)) if (!seen.has(k)) seen.set(k, v);
  console.log(`  ${title} fields: ${[...seen.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`);
};

const [spots, gates, lights, fans, alarms, zones] = await Promise.all([
  sim.listParkingSpots(), sim.listBarriers(), sim.listLights(), sim.listExhaustFans(), sim.listAlarms(), sim.listZones(),
]) as [SimParkingSpot[], SimBarrier[], Row[], Row[], Row[], Row[]];

const entries = spots.filter((s) => s.purpose === "EntrySpot").map((s) => s.name).sort();
console.log(`Level with entries [${entries.join(", ")}] - ${spots.length} spots, ${gates.length} gates, ` +
  `${lights.length} lights, ${fans.length} exhaust fans, ${zones.length} zones, ${alarms.length} alarms`);

table("Spots by purpose | zone | car type", count(spots, (s) => `${s.purpose} | ${s.zoneParent || "-"} | ${s.parkingForCarType || "-"}`));
fields("spot", spots as unknown as Row[]);
const odd = spots.filter((s) => s.broken || s.isUnderMaintenance || (Array.isArray(s.detectedCars) ? s.detectedCars.length : Number(s.detectedCars)));
if (odd.length) console.log(`  not idle: ${odd.map((s) => `${s.name}${s.broken ? " BROKEN" : ""}${s.isUnderMaintenance ? " MAINT" : ""} cars=${JSON.stringify(s.detectedCars)}`).join("; ")}`);

table("Gates", gates.map((g) => [`${g.name} (zone ${g.zoneParent || "-"}) ${g.state}${g.broken ? " BROKEN" : ""}${g.isUnderMaintenance ? " MAINT" : ""}`, 1]));
table("Lights by group | zone | on", count(lights, (l) => `${l.group} | ${l.zoneParent || "-"} | ${l.isOn ? "on" : "off"}`));
fields("light", lights);
table("Exhaust fans by zone | on | state", count(fans, (f) => `${f.zoneParent || "-"} | ${f.isOn ? "on" : "off"} | ${f.broken ? "BROKEN" : f.isUnderMaintenance ? "MAINT" : "ok"}`));
fields("fan", fans);
console.log("\nZones (CO)");
for (const z of zones) console.log(`  ${JSON.stringify(z)}`);
console.log("\nAlarms");
for (const a of alarms) console.log(`  ${JSON.stringify(a)}`);
if (!alarms.length) console.log("  none");

const dir = path.join(cfg.dataDir, "discovery");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `discovery-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), spots, gates, lights, fans, alarms, zones }, null, 2));
console.log(`\nsaved ${file}`);
