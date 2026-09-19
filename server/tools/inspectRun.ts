/**
 * Print the merged event/command timeline of the latest run from the database.
 *   npx tsx tools/inspectRun.ts [seconds-from-start=40] [skip-seconds=0]
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
const span = Number(process.argv[2] ?? 40), skip = Number(process.argv[3] ?? 0);

// a run starts after the last gap of > 20 s between received events
const times = (db.prepare("SELECT received_ms FROM events ORDER BY id").all() as { received_ms: number }[]).map((r) => r.received_ms);
let start = times[0];
for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 20_000) start = times[i];
const from = start + skip * 1000, to = from + span * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
console.log(`run start ${new Date(start).toLocaleTimeString()}  showing +${skip}s..+${skip + span}s`);

const evs = db.prepare("SELECT received_ms t, payload FROM events WHERE received_ms BETWEEN ? AND ?").all(from, to) as { t: number; payload: string }[];
const acts = db.prepare("SELECT at, cmd, args, ok FROM actions WHERE at BETWEEN ? AND ?").all(iso(from), iso(to)) as { at: string; cmd: string; args: string; ok: number }[];
const rows = [
  ...evs.map((r) => { const e = JSON.parse(r.payload); return { t: r.t, s: `EV  ${e.EventClass.padEnd(16)} ${e.CarPlateNumber ?? e.Name ?? ""} ${e.Direction ?? e.Action ?? ""} ${e.SpotName ?? ""} ${e.Amount ?? ""} ${e.Reason ?? ""}` }; }),
  ...acts.map((a) => ({ t: Date.parse(a.at), s: `CMD ${a.cmd} ${JSON.parse(a.args).join(" ")}${a.ok ? "" : " FAILED"}` })),
].sort((a, b) => a.t - b.t);
for (const r of rows) console.log(`+${((r.t - start) / 1000).toFixed(2).padStart(7)}s ${r.s}`);
