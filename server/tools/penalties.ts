/**
 * Every penalty in the database with the context that explains it: for "occupied spot"
 * penalties, who was in that spot, what we believed, and what we commanded.
 *   npm run report:penalties -w server -- [minutes=120]
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
const minutes = Number(process.argv[2] ?? 120);
const since = Date.now() - minutes * 60_000;
const time = (ms: number) => new Date(ms).toLocaleTimeString();

type Ev = { id: number; t: number; plate: string | null; spot: string | null; payload: string };
const events = db.prepare("SELECT id, received_ms t, plate, spot, payload FROM events WHERE received_ms >= ? ORDER BY id").all(since) as Ev[];
const actions = db.prepare("SELECT at, cmd, args, actor FROM actions WHERE at >= ? ORDER BY id").all(new Date(since).toISOString()) as
  { at: string; cmd: string; args: string; actor: string | null }[];

const penalties = events.filter((e) => JSON.parse(e.payload).EventClass === "penalty");
const byReason = new Map<string, number>();
for (const p of penalties) {
  const r = String(JSON.parse(p.payload).Reason).replace(/\([^)]*\)/g, "(…)").replace(/:\S+/g, ":…");
  byReason.set(r, (byReason.get(r) ?? 0) + 1);
}
console.log(`penalties in the last ${minutes} min: ${penalties.length}`);
for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

// Billing-related penalties: the car's own events and our commands in the 2 minutes before
const plateOf = (component: string) => events.find((e) => e.plate?.replace(/ /g, "") === component)?.plate ?? component;
for (const p of penalties.filter((p) => /already paid|charged at the exit|escaped|charged wrongly/i.test(JSON.parse(p.payload).Reason))) {
  const pay = JSON.parse(p.payload), plate = plateOf(pay.ComponentName);
  const hist = events.filter((e) => e.plate === plate && e.t > p.t - 120_000 && e.t <= p.t + 500).map((e) => {
    const x = JSON.parse(e.payload);
    return `${time(e.t)} ${x.EventClass === "payment_made" ? `PAID ${x.Amount}` : `${x.Direction}@${x.SpotName}`}`;
  });
  const cmds = actions.filter((a) => a.args.startsWith(`["${plate}"`) && Date.parse(a.at) > p.t - 120_000 && Date.parse(a.at) <= p.t + 500)
    .map((a) => `${time(Date.parse(a.at))} ${a.cmd} ${JSON.parse(a.args).slice(1).join(" ")}`);
  console.log(`\n${time(p.t)} ${String(pay.Reason).slice(0, 45)} | ${plate}\n   events: ${hist.join(" | ")}\n   cmds  : ${cmds.join(" | ")}`);
}

// Detail the first few occupied-spot penalties
const occupied = penalties.filter((p) => /occupied spot/i.test(JSON.parse(p.payload).Reason)).slice(0, Number(process.argv[3] ?? 4));
for (const p of occupied) {
  const pay = JSON.parse(p.payload);
  console.log(`\n=== ${time(p.t)} ${pay.Reason}  (component ${pay.ComponentName})`);
  const spot = /spot:\s*\(?([A-Za-z0-9_]+)/i.exec(pay.Reason)?.[1];
  const plate = /Car:\s*\(?([A-Z]{3}\s?\d{3})/i.exec(pay.Reason)?.[1] ?? pay.ComponentName;
  console.log(`  spot=${spot} car=${plate}`);
  const window = (e: Ev) => e.t > p.t - 12 * 60_000 && e.t <= p.t + 2000;
  for (const e of events.filter((e) => window(e) && e.spot === spot)) {
    const x = JSON.parse(e.payload);
    console.log(`   ${time(e.t)}  EV  ${spot} ${x.Direction} ${x.CarPlateNumber}`);
  }
  for (const a of actions.filter((a) => {
    const t = Date.parse(a.at);
    return t > p.t - 12 * 60_000 && t <= p.t + 2000 && a.args.includes(`"${spot}"`);
  })) console.log(`   ${time(Date.parse(a.at))}  CMD ${a.cmd} ${JSON.parse(a.args).join(" ")}${a.actor ? ` (by ${a.actor})` : ""}`);
}
