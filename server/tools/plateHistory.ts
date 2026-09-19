/**
 * Every event and command for one plate, from the database.
 *   npm run report:plate -w server -- "FKC 430"
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const plate = process.argv[2];
if (!plate) { console.error('usage: report:plate -- "ABC 123"'); process.exit(2); }
const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
const compact = plate.replace(/ /g, "");

const evs = (db.prepare("SELECT received_ms t, payload FROM events WHERE plate = ? OR payload LIKE ?")
  .all(plate, `%"ComponentName":"${compact}"%`) as { t: number; payload: string }[])
  .map((r) => { const e = JSON.parse(r.payload); return { t: r.t, s: `EV  ${e.EventClass.padEnd(16)} ${e.Direction ?? ""} ${e.SpotName ?? ""} ${e.Amount ?? ""} ${e.Reason ?? ""}` }; });
const acts = (db.prepare("SELECT at, cmd, args, ok FROM actions WHERE args LIKE ?").all(`["${plate}"%`) as { at: string; cmd: string; args: string; ok: number }[])
  .map((a) => ({ t: Date.parse(a.at), s: `CMD ${a.cmd} ${JSON.parse(a.args).slice(1).join(" ")}${a.ok ? "" : " FAILED"}` }));
const sessions = db.prepare("SELECT recorded_at, status, spot, charge_parking, paid FROM sessions WHERE plate = ?").all(plate);

for (const r of [...evs, ...acts].sort((a, b) => a.t - b.t)) console.log(new Date(r.t).toLocaleTimeString(), r.s);
console.log("sessions:", sessions);
