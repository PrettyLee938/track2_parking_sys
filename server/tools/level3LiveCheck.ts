/**
 * Level 3 acceptance check. The server and the simulator must already be running
 * with a Level 3 layout loaded. This is intentionally read-only: it verifies the
 * live topology/read model, equipment inventory, environment policy, security log,
 * and controller health without sending simulator commands.
 */
type Json = Record<string, any>;

import { loadDotEnv, loadSettings } from "../src/config";

loadDotEnv();
const base = `http://127.0.0.1:${loadSettings().appPort}`;
let cookie = "";
let failures = 0;
const check = (label: string, condition: unknown, detail = "") => {
  if (!condition) failures++;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
};
async function get(path: string): Promise<Json> {
  const response = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : undefined });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<Json>;
}

try {
  console.log(`Level 3 live check against ${base}`);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: process.env.GPA_ADMIN_USERNAME ?? "admin", password: process.env.GPA_ADMIN_PASSWORD ?? "admin-password" }) });
  cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
  const [state, debugStats, recent, security] = await Promise.all([
    get("/debug/controller"), get("/debug/stats"), get("/debug/recent?n=1000"), get("/debug/security"),
  ]);
  const env = (state.environment ?? state.subsystems?.environment) as Json | undefined;
  const components = Array.isArray(state.components) ? state.components : [];
  const kindCount = (kind: string) => components.filter((c: Json) => c.kind === kind).length;
  const topology = typeof state.topology === "string" ? state.topology : state.topology?.name;

  check("server is synced to Level 3", state.synced === true && /lvl?3|level3/i.test(String(topology)), String(topology ?? "none"));
  check("simulator REST API is online", state.simulator?.online === true,
    state.simulator?.online ? (state.simulator?.last_success_at ?? "online") : (state.simulator?.last_error ?? "no successful simulator probe"));
  check("eight entry lanes", state.entry_lanes?.length === 8, String(state.entry_lanes?.length ?? 0));
  check("ten exit lanes", state.exit_lanes?.length === 10, String(state.exit_lanes?.length ?? 0));
  check("seven zones are represented", Object.keys(state.zones ?? {}).filter((z) => z !== "-").length === 7, Object.keys(state.zones ?? {}).join(", "));
  check("250 parking spots are discovered", Object.values(state.zones ?? {}).reduce((n: number, z: any) => n + z.total, 0) === 250);
  check("12 exhaust fans discovered", kindCount("fan") === 12, String(kindCount("fan")));
  check("30 lights discovered", kindCount("light") === 30, String(kindCount("light")));
  check("component summary matches inventory", state.component_summary?.total === components.length);
  check("environment covers the three indoor CO zones", Array.isArray(env?.zones) && env.zones.length >= 3, String(env?.zones?.length ?? 0));
  check("controller queue has no command failures", state.counters?.command_errors === 0, String(state.counters?.command_errors ?? "unknown"));
  check("all accepted simulator calls have signatures", debugStats.sig_unsigned === 0 && (debugStats.sig_invalid ?? 0) === 0,
    `valid=${debugStats.sig_valid}, unsigned=${debugStats.sig_unsigned}, invalid=${debugStats.sig_invalid}`);
  check("security endpoint is available", Array.isArray(security.items));
  check("dashboard state is bounded", (state.spots?.length ?? 0) <= 300 && (state.feed?.length ?? 0) <= 300);
  if (Array.isArray(recent)) check("no malformed event entered controller", recent.every((e: Json) => e.EventClass), String(recent.length));
} catch (error) {
  failures++;
  console.error(`  [FAIL] live check could not complete: ${(error as Error).message}`);
}

console.log(failures ? `\n${failures} LIVE CHECK(S) FAILED` : "\nALL LEVEL 3 LIVE CHECKS PASS");
process.exit(failures ? 1 : 0);
