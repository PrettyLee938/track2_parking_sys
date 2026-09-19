/**
 * Live Level 2 acceptance check.
 *
 * Prerequisites: the server and the real simulator are running, the simulator
 * is on lvl2, and its WebhookUrl points at this server.
 *
 *   npm run level2-live
 */
type Json = Record<string, any>;

import { loadDotEnv, loadSettings } from "../src/config";

loadDotEnv();
const base = `http://127.0.0.1:${loadSettings().appPort}`;
let failures = 0;
const check = (label: string, condition: unknown, detail = "") => {
  if (!condition) failures++;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
};

async function get(path: string): Promise<Json> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<Json>;
}

try {
  console.log(`Level 2 live check against ${base}`);
  const [state, stats, recent] = await Promise.all([get("/debug/controller"), get("/debug/stats"), get("/debug/recent?n=500")]);
  const environment = (state.subsystems?.environment ?? state.environment) as Json | undefined;
  const zones = Array.isArray(environment?.zones) ? environment.zones : [];
  const components = Array.isArray(state.components) ? state.components : [];
  const componentCount = (kind: string) => components.filter((c: Json) => c.kind === kind).length;

  const topologyName = typeof state.topology === "string" ? state.topology : state.topology?.name;
  check("server is synced to lvl2", state.synced === true && topologyName === "lvl2", String(topologyName ?? "none"));
  check("three entry lanes", state.entry_lanes?.length === 3, String(state.entry_lanes?.length ?? 0));
  check("three exit lanes", state.exit_lanes?.length === 3, String(state.exit_lanes?.length ?? 0));
  check("three independent zone summaries", Object.keys(state.zones ?? {}).filter((z) => z !== "-").length === 3,
    Object.keys(state.zones ?? {}).join(", "));
  check("90 parking spots", Object.values(state.zones ?? {}).reduce((n: number, z: any) => n + z.total, 0) === 90);

  check("12 exhaust fans discovered", componentCount("fan") === 12, String(componentCount("fan")));
  check("30 lights discovered", componentCount("light") === 30, String(componentCount("light")));
  check("environment reports all zones", zones.length === 3, String(zones.length));
  check("each zone has four fans and ten lights", zones.every((z: Json) => z.fans === 4 && z.lights === 10));

  const daylight = environment?.lights?.night === false;
  if (daylight) check("daytime keeps every light off", environment?.lights?.on === 0, JSON.stringify(environment?.lights));
  else console.log("  [INFO] night policy active; light demand depends on moving traffic");

  const measuredZones = zones.filter((z: Json) => typeof z.co === "number");
  check("all measured safe zones do not run fans unnecessarily",
    measuredZones.length > 0 && measuredZones.length === zones.length && measuredZones.every((z: Json) => z.co < 50 && z.fans_on === 0),
    `${measuredZones.length}/${zones.length} zones measured`);
  check("cars are flowing", (state.counters?.arrived ?? 0) > 0 && (state.counters?.admitted ?? 0) > 0,
    `arrived=${state.counters?.arrived ?? 0}, admitted=${state.counters?.admitted ?? 0}`);
  check("no controller command errors", state.counters?.command_errors === 0, String(state.counters?.command_errors ?? "unknown"));
  const invalidEvents = (Array.isArray(recent) ? recent : []).filter((e: Json) => e._sig === "invalid");
  const invalidNonPayment = invalidEvents.filter((e: Json) => e.EventClass !== "payment_made");
  check("webhooks are signed or intentionally quarantined",
    stats.sig_valid > 0 && stats.sig_unsigned === 0 && invalidNonPayment.length === 0 &&
      (stats.sig_invalid === 0 || invalidEvents.length > 0),
    `valid=${stats.sig_valid}, unsigned=${stats.sig_unsigned}, invalid=${stats.sig_invalid}, invalid_payment_events=${invalidEvents.length}`);

  if (stats.seq_gaps > 0) console.log(`  [INFO] ${stats.seq_gaps} sequence gap(s) recorded; inspect after simulator/server restart`);
} catch (error) {
  failures++;
  console.error(`  [FAIL] live check could not complete: ${(error as Error).message}`);
}

console.log(failures ? `\n${failures} LIVE CHECK(S) FAILED` : "\nALL LIVE CHECKS PASS");
process.exit(failures ? 1 : 0);
