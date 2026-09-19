/**
 * Silences (likely simulator restarts) and SequenceId gaps (lost webhooks) in the
 * database, plus who used a given spot.   npm run report:gaps -w server -- [spot]
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
const rows = db.prepare("SELECT received_ms t, seq, payload FROM events ORDER BY id").all() as { t: number; seq: number | null; payload: string }[];
const time = (ms: number) => new Date(ms).toLocaleTimeString();

console.log("silences > 20 s (simulator stopped/restarted?):");
for (let i = 1; i < rows.length; i++) {
  const gap = rows[i].t - rows[i - 1].t;
  if (gap > 20_000) console.log(`  ${time(rows[i - 1].t)} -> ${time(rows[i].t)}  (${Math.round(gap / 1000)} s)`);
}

let missing = 0;
console.log("SequenceId gaps (webhooks we never received):");
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1].seq, b = rows[i].seq;
  if (a !== null && b !== null && b > a + 1) {
    missing += b - a - 1;
    console.log(`  ${time(rows[i].t)}  ${a} -> ${b}  (${b - a - 1} missing)`);
  }
}
console.log(`  total missing: ${missing} of ${rows.length}`);

const spot = process.argv[2];
if (spot) {
  console.log(`events at ${spot}:`);
  for (const r of rows) {
    const e = JSON.parse(r.payload);
    if (e.SpotName === spot) console.log(`  ${time(r.t)} ${e.CarPlateNumber} ${e.Direction}`);
  }
}
