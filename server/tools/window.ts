/**
 * Every event and command in a local-time window, merged in order.
 *   npm run report:window -w server -- 16:27:05 16:27:40 [YYYY-MM-DD]
 */
import Database from "better-sqlite3";
import path from "node:path";
import { REPO_ROOT } from "../src/config";

const [fromArg, toArg, dayArg] = process.argv.slice(2);
if (!fromArg || !toArg) { console.error("usage: report:window -- HH:MM:SS HH:MM:SS [YYYY-MM-DD]"); process.exit(2); }
const day = dayArg ?? new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local
const at = (hms: string) => new Date(`${day}T${hms}`).getTime(); // no zone suffix = local time
const from = at(fromArg), to = at(toArg);

const db = new Database(path.join(REPO_ROOT, "data", "gpa.db"), { readonly: true });
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false }) + "." + String(ms % 1000).padStart(3, "0");
const rows = [
  ...(db.prepare("SELECT received_ms t, seq, payload FROM events WHERE received_ms BETWEEN ? AND ?").all(from, to) as { t: number; seq: number; payload: string }[])
    .map((r) => { const e = JSON.parse(r.payload); return { t: r.t, s: `EV  #${r.seq} ${e.EventClass} ${e.CarPlateNumber ?? e.Name ?? ""} ${e.Direction ?? e.Action ?? ""} ${e.SpotName ?? ""} ${e.Reason ?? ""}` }; }),
  ...(db.prepare("SELECT at, cmd, args, actor FROM actions WHERE at BETWEEN ? AND ?").all(new Date(from).toISOString(), new Date(to).toISOString()) as { at: string; cmd: string; args: string; actor: string | null }[])
    .map((a) => ({ t: Date.parse(a.at), s: `CMD ${a.cmd} ${JSON.parse(a.args).join(" ")}${a.actor ? ` by ${a.actor}` : ""}` })),
].sort((a, b) => a.t - b.t);
for (const r of rows) console.log(clock(r.t), r.s);
