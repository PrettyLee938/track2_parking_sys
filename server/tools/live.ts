/**
 * What the running engine is doing right now: lanes, gates (and how worn they are), parts
 * out of service, the task queue and the latest feed. Run it while a level is playing.
 *   npm run report:live -w server
 */
import { LISTENER } from "./site";

const res = await fetch(`${LISTENER}/debug/controller`).catch((e) => { console.error(`server not reachable: ${e.message}`); process.exit(1); });
const s = await res.json() as Record<string, any>;
type ComponentDebug = { kind: string; name: string; uses?: number; health?: string; waiting?: string | null };
const components = new Map<string, ComponentDebug>((s.components ?? []).map((c: ComponentDebug) => [`${c.kind}:${c.name}`, c]));
const cars = s.cars ?? (s.active_cars ?? []).length;
const level = typeof s.topology === "string" ? s.topology : s.topology?.name ?? "-";
const gateLimit = s.gate_limit ?? "learned";
console.log(`synced=${s.synced} level=${level} speed=x${s.time_scale} (${s.time_scale_source}) cars=${cars} gate_limit=${gateLimit}`);
// The serial queue is the only writer, so a backlog here is the whole system falling
// behind - the first thing to look at during a Level 3 burst.
const q = s.queue;
if (q) {
  console.log(`queue: depth=${q.depth} running=${q.running ?? "-"} (${q.running_ms}ms) oldest_wait=${q.oldest_wait_ms}ms` +
    ` done=${q.completed} failed=${q.failed} handler avg=${q.avg_ms}ms p95=${q.p95_ms}ms max=${q.max_ms}ms (${q.slowest ?? "-"})`);
}
console.log("\nentrances");
for (const l of s.entry_lanes ?? []) console.log(`  ${l.spot} gate=${l.gate} current=${l.current ?? "-"} queue=${l.queue?.length ?? 0}${l.closed ? " CLOSED" : ""}`);
console.log("exits");
for (const l of s.exit_lanes ?? []) console.log(`  ${l.spot} gate=${l.gate} releasing=${l.releasing?.join(",") || "-"}`);
console.log("gates");
for (const g of s.gates ?? []) {
  const c = components.get(`gate:${g.name}`);
  console.log(`  ${g.name.padEnd(6)} ${String(g.state).padEnd(8)} uses=${g.uses ?? c?.uses ?? "?"}${g.worn ? " WORN" : ""}${g.broken ? " BROKEN" : ""}${g.maintenance ? " REPAIRING" : ""}${g.hold ? ` hold=${g.hold}` : ""}${g.waiting ? ` waiting: ${g.waiting}` : c?.waiting ? ` waiting: ${c.waiting}` : ""}`);
}
const outOfService = s.out_of_service ?? (s.components ?? []).filter((c: any) => c.health !== "ok").map((c: any) => `${c.kind}:${c.name}=${c.health}`);
console.log(`out of service: ${outOfService.join("; ") || "none"}`);
const environment = s.environment ?? s.subsystems?.environment;
for (const z of environment?.zones ?? []) console.log(`fans ${z.zone}: CO ${z.co === null ? "?" : Number(z.co).toFixed(0)} ${z.risk ?? ""} -> ${z.fans_on}/${z.fans} on${z.forced ? " (CO penalty)" : ""}  [list-zones polls: ${environment.polls}]`);
if (s.unreachable?.length) console.log(`unreachable (learned): ${s.unreachable.join(", ")}`);
console.log(`counters: ${JSON.stringify(s.counters)}`);
console.log("\nlatest feed");
for (const f of (s.feed ?? []).slice(-25)) console.log(`  ${new Date(f.at).toLocaleTimeString([], { hour12: false })} ${f.level.padEnd(5)} ${f.msg}`);
