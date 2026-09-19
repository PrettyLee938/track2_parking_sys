/**
 * For every car turned away in the latest database: how many park spots were occupied
 * (per sensor events) at that moment.   npx tsx tools/turnAways.ts
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
const events = (db.prepare("SELECT received_ms t, payload FROM events ORDER BY id").all() as { t: number; payload: string }[])
  .map((r) => ({ t: r.t, e: JSON.parse(r.payload) }));
const turned = (db.prepare("SELECT at, args FROM actions WHERE cmd = 'goto' ORDER BY id").all() as { at: string; args: string }[])
  .map((a) => ({ t: Date.parse(a.at), args: JSON.parse(a.args) as string[] }))
  .filter((a) => a.args[1] === "leavepark");

const occupied = new Map<string, boolean>();
let i = 0, full = 0, notFull = 0;
const notFullCounts: number[] = [];
const planned: number[] = [];
for (const a of turned) {
  while (i < events.length && events[i].t <= a.t) {
    const { e } = events[i++];
    if (e.SpotType === "Park") occupied.set(e.SpotName, e.Direction === "CarIn");
    if (e.SpotType === "Park" && e.Direction === "CarIn") planned.push(Number(e.PlannedParkingDurationInMinutes));
  }
  const last = [...events.slice(0, i)].reverse().find((x) => x.e.CarPlateNumber === a.args[0]);
  if (last?.e.SpotName !== "ENTRY1") continue; // a paid car leaving, not a turn-away
  const n = [...occupied.values()].filter(Boolean).length;
  if (n >= 30) full++; else { notFull++; notFullCounts.push(n); }
}
const mean = planned.reduce((s, x) => s + x, 0) / (planned.length || 1);
console.log(`turned away: ${full + notFull}  (car park full: ${full}, with free spots: ${notFull})`);
console.log(`occupied spots at the non-full turn-aways: ${notFullCounts.sort((a, b) => a - b).join(", ")}`);
console.log(`mean planned stay: ${mean.toFixed(1)} game-min over ${planned.length} parkings`);
