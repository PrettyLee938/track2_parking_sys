/**
 * Replay a stored run through the game clock and show how its speed estimate followed the
 * simulator (stays and gate timing), e.g. after Shift+PgUp changes.
 *   npm run report:speed -w server -- [HH:MM] [HH:MM] [YYYY-MM-DD]
 */
import Database from "better-sqlite3";
import path from "node:path";
import { loadSettings, REPO_ROOT } from "../src/config";
import { GameClock } from "../src/gameClock";

const [fromArg = "00:00", toArg = "23:59", dayArg] = process.argv.slice(2);
const day = dayArg ?? new Date().toLocaleDateString("sv");
const from = new Date(`${day}T${fromArg}`).getTime(), to = new Date(`${day}T${toArg}`).getTime();

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
type Row = { t: number; ev?: Record<string, string>; cmd?: string; gate?: string };
const rows: Row[] = [
  ...(db.prepare("SELECT received_ms t, payload FROM events WHERE received_ms BETWEEN ? AND ?").all(from, to) as { t: number; payload: string }[])
    .map((r) => ({ t: r.t / 1000, ev: JSON.parse(r.payload) })),
  ...(db.prepare("SELECT at, cmd, args, ms, actor FROM actions WHERE ok = 1 AND cmd IN ('open', 'close') AND at BETWEEN ? AND ?")
    .all(new Date(from).toISOString(), new Date(to).toISOString()) as { at: string; cmd: string; args: string; ms: number; actor: string | null }[])
    .filter((a) => !a.actor).map((a) => ({ t: (Date.parse(a.at) - (a.ms ?? 0)) / 1000, cmd: a.cmd, gate: JSON.parse(a.args)[0] })),
].sort((a, b) => a.t - b.t);
if (!rows.length) { console.log("nothing in that window"); process.exit(0); }

let now = rows[0].t;
const clock = new GameClock(loadSettings(), () => now);
const parked = new Map<string, number>();
const gates = new Map<string, { state: string; sent: number | null }>();
let lastPrint = 0, lastSource = "";
const clockTime = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour12: false });

for (const r of rows) {
  now = r.t;
  if (r.cmd) {
    const g = gates.get(r.gate!) ?? { state: "Closed", sent: null };
    const clean = r.cmd === "open" ? g.state === "Closed" : g.state === "Open";
    g.state = r.cmd === "open" ? "Opening" : "Closing";
    g.sent = clean ? r.t : null;
    gates.set(r.gate!, g);
    continue;
  }
  const e = r.ev!;
  clock.activity();
  if (e.EventClass === "gate_action") {
    const g = gates.get(e.Name) ?? { state: e.Action, sent: null };
    const expected = g.state === "Opening" ? "Open" : g.state === "Closing" ? "Closed" : null;
    if (g.sent !== null && e.Action === expected) {
      const change = clock.addGateMove(r.t - g.sent);
      if (change) console.log(`${clockTime(r.t)}  CHANGE DETECTED by gates: x${change.from.toFixed(2)} -> x${change.to.toFixed(2)}`);
    }
    g.state = e.Action; g.sent = null;
    gates.set(e.Name, g);
  } else if (e.EventClass === "car_spot_action" && e.SpotType === "Park") {
    if (e.Direction === "CarIn") parked.set(e.CarPlateNumber, clock.activeNow());
    else if (parked.has(e.CarPlateNumber)) {
      const a = parked.get(e.CarPlateNumber)!, b = clock.activeNow();
      parked.delete(e.CarPlateNumber);
      const truth = (Number(e.PlannedParkingDurationInMinutes) * 60) / (b - a);
      clock.addStay(Number(e.PlannedParkingDurationInMinutes), a, b);
      const { value, source } = clock.info;
      if (r.t - lastPrint > 30 || source !== lastSource) {
        console.log(`${clockTime(r.t)}  estimate x${value.toFixed(2)} (${source})  this stay x${truth.toFixed(2)}`);
        lastPrint = r.t; lastSource = source;
      }
    }
  }
}
