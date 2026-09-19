/**
 * End-to-end connectivity check: REST API in both directions + webhook delivery.
 *
 * Prereqs: simulator running, the app running (npm run dev), and the simulator's
 * settings.json WebhookUrl pointing at http://127.0.0.1:<port>/webhook.
 *
 *   npm run smoke            (add -- --gates to also cycle the first entry gate;
 *                             only with GPA_CONTROLLER_ENABLED=false)
 */
import { EventClass, GateState, SpotPurpose } from "@gpa/shared";
import { LISTENER, recentEvents, resolveSite, sim, waitFor } from "./site";

let ok = true;
const check = (label: string, cond: unknown, detail = "") => {
  ok &&= !!cond;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
};
const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;

console.log("1. Listener");
try {
  await fetch(`${LISTENER}/debug/stats`);
  check("app reachable", true, LISTENER);
} catch (e) {
  check("app reachable", false, (e as Error).message);
  process.exit(1);
}

console.log("2. REST API (us -> simulator)");
let t0 = performance.now();
await sim.login();
check("login", true, ms(t0));
const spots = await sim.listParkingSpots();
const park = spots.filter((s) => s.purpose === SpotPurpose.Park);
check("list-parking-spots", park.length, `${park.length} park spots, ${spots.length - park.length} other`);
const gates = new Map((await sim.listBarriers()).map((g) => [g.name, g]));
const site = await resolveSite();
check("topology resolved", site.source !== "fallback", `${site.name}: ${site.entry_lanes.length} entries, ${site.exit_lanes.length} exits`);
const GATE = site.entry_lanes.find((l) => l.gate)?.gate ?? null;
check("list-barriers", GATE && gates.has(GATE), [...gates.values()].map((g) => `${g.name}=${g.state}`).join(", "));

console.log("3. Webhook delivery (simulator -> app)");
const seen = new Set((await recentEvents()).map((e) => e.EventId!).filter(Boolean));
const msg = await sim.testWebhook();
check("/test points at our app", /127\.0\.0\.1|localhost/.test(String(msg)), String(msg));
const ev = await waitFor((e) => e.EventClass === EventClass.Test, 15, seen);
check("test_webhook event received", ev, ev ? `seq=${ev.SequenceId}` : "");
// Level 1 sends Signature=null (even for /test once a level is running); only fail on a bad one.
check("test_webhook signature not invalid", ev && ev._sig !== "invalid", ev?._sig);

console.log(`4. Command round-trip on ${GATE}`);
const g = GATE ? gates.get(GATE) : undefined;
if (!process.argv.includes("--gates")) {
  console.log("  [SKIP] pass --gates to cycle the gate (only with GPA_CONTROLLER_ENABLED=false, or it interferes with the controller)");
} else if (!g) {
  check("entry gate present", false, "no level loaded? start a level in the simulator window");
} else if (g.broken || g.isUnderMaintenance) {
  check(`${GATE} operable`, false, "broken/under maintenance - skipping (operating it is a penalty)");
} else {
  for (const [action, call, target] of [["open", sim.openGate, GateState.Open], ["close", sim.closeGate, GateState.Closed]] as const) {
    t0 = performance.now();
    await call(GATE!);
    check(`POST ${action} accepted`, true, ms(t0));
    const got = await waitFor((e) => e.EventClass === EventClass.GateAction && e.Name === GATE && e.Action === target, 15, seen);
    check(`gate_action ${target} webhook`, got, got?._sig);
  }
}

console.log("\nApp intake stats:", await (await fetch(`${LISTENER}/debug/stats`)).json());
console.log(ok ? "\nALL PASS" : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
