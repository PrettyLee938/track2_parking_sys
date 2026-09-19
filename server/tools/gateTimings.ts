/**
 * Gate timing report for the latest database: how long gates stay open and how long
 * cars take to clear them.   npx tsx tools/gateTimings.ts
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
type Row = { t: number; e: Record<string, string> };
const rows: Row[] = (db.prepare("SELECT received_ms t, payload FROM events ORDER BY id").all() as { t: number; payload: string }[])
  .map((r) => ({ t: r.t, e: JSON.parse(r.payload) }));
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const f = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return s.length ? `n=${s.length} median=${f(s[s.length >> 1])} p90=${f(s[Math.floor(s.length * 0.9)])} max=${f(s.at(-1)!)}` : "n=0";
};

for (const gate of ["gateA", "gateB"]) {
  const open: number[] = [];
  let since: number | null = null;
  for (const r of rows.filter((r) => r.e.EventClass === "gate_action" && r.e.Name === gate)) {
    if (r.e.Action === "Open") since = r.t;
    else if (r.e.Action === "Closed" && since !== null) { open.push(r.t - since); since = null; }
  }
  console.log(`${gate} open -> closed:              ${stats(open)}`);
}
for (const [gate, spot] of [["gateA", "ENTRY1"], ["gateB", "EXIT_EXIT"]]) {
  const lag: number[] = [];
  rows.forEach((r, i) => {
    if (r.e.SpotName !== spot || r.e.Direction !== "CarOut") return;
    const next = rows.slice(i).find((x) => x.e.EventClass === "gate_action" && x.e.Name === gate);
    if (next?.e.Action === "Closed" || next?.e.Action === "Closing") lag.push(next.t - r.t);
  });
  console.log(`${spot} CarOut -> ${gate} closing:  ${stats(lag)}`);
}
const after = (from: Row, pred: (x: Row) => boolean) => rows.find((x) => x.t >= from.t && pred(x));
const payToOut = rows.filter((r) => r.e.EventClass === "payment_made")
  .map((p) => after(p, (x) => x.e.CarPlateNumber === p.e.CarPlateNumber && x.e.SpotName === "EXIT_EXIT" && x.e.Direction === "CarOut"))
  .map((o, i, arr) => o ? o.t : null);
const pays = rows.filter((r) => r.e.EventClass === "payment_made");
console.log(`payment -> exit CarOut:             ${stats(pays.map((p, i) => payToOut[i] !== null ? payToOut[i]! - p.t : NaN).filter((x) => !Number.isNaN(x)))}`);
const entryToPark = rows.filter((r) => r.e.SpotName === "ENTRY1" && r.e.Direction === "CarOut")
  .map((r) => { const p = rows.find((x) => x.t > r.t && x.e.CarPlateNumber === r.e.CarPlateNumber && x.e.SpotType === "Park" && x.e.Direction === "CarIn"); return p ? p.t - r.t : NaN; })
  .filter((x) => !Number.isNaN(x));
console.log(`entry CarOut -> parked:             ${stats(entryToPark)}`);
const arrivals = rows.filter((r) => r.e.SpotName === "ENTRY1" && r.e.Direction === "CarIn").map((r) => r.t);
console.log(`gap between arrivals:               ${stats(arrivals.slice(1).map((t, i) => t - arrivals[i]).filter((g) => g < 30_000))}`);
