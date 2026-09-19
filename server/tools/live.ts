/**
 * What the running engine is doing right now: lanes, gates (and how worn they are), parts
 * out of service, the task queue and the latest feed. Run it while a level is playing.
 *   npm run report:live -w server
 */
import { LISTENER } from "./site";

const res = await fetch(`${LISTENER}/debug/controller`).catch((e) => { console.error(`server not reachable: ${e.message}`); process.exit(1); });
const s = await res.json() as Record<string, any>;
console.log(`synced=${s.synced} level=${s.topology} speed=x${s.time_scale} (${s.time_scale_source}) queue_depth=${s.queue_depth} cars=${s.cars} gate_limit=${s.gate_limit}`);
console.log("\nentrances");
for (const l of s.entry_lanes) console.log(`  ${l.spot} gate=${l.gate} current=${l.current ?? "-"} queue=${l.queue.length}${l.closed ? " CLOSED" : ""}`);
console.log("exits");
for (const l of s.exit_lanes) console.log(`  ${l.spot} gate=${l.gate} releasing=${l.releasing.join(",") || "-"}`);
console.log("gates");
for (const g of s.gates) console.log(`  ${g.name.padEnd(6)} ${String(g.state).padEnd(8)} uses=${g.uses}${g.worn ? " WORN" : ""}${g.broken ? " BROKEN" : ""}${g.maintenance ? " REPAIRING" : ""}${g.hold ? ` hold=${g.hold}` : ""}${g.waiting ? ` waiting: ${g.waiting}` : ""}`);
console.log(`out of service: ${s.out_of_service.join("; ") || "none"}`);
for (const z of s.environment?.zones ?? []) console.log(`fans ${z.zone}: ${z.fans_on}/${z.fans} on${z.co_alert ? " CO ALERT" : z.busy ? " (cars moving)" : ""}${z.last_co ? `, last CO ${z.last_co.level.toFixed(0)} ${z.last_co.danger}` : ""}`);
if (s.unreachable?.length) console.log(`unreachable (learned): ${s.unreachable.join(", ")}`);
console.log(`counters: ${JSON.stringify(s.counters)}`);
console.log("\nlatest feed");
for (const f of s.feed.slice(-25)) console.log(`  ${new Date(f.at).toLocaleTimeString([], { hour12: false })} ${f.level.padEnd(5)} ${f.msg}`);
