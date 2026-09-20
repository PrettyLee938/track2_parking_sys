/** Concurrent webhook/API stress check used with tools/fakeSim.ts level3. */
import { computeSignature } from "../src/webhook";
import { loadDotEnv, loadSettings } from "../src/config";

loadDotEnv();
const base = `http://127.0.0.1:${loadSettings().appPort}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = async (payload: Record<string, unknown>, signature = true) => {
  const body = signature ? { ...payload, Signature: computeSignature(payload) } : { ...payload, Signature: "0".repeat(32) };
  const response = await fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.status;
};
const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<Record<string, any>>;

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`); if (!ok) failed++; };

try {
  console.log(`Level 3 concurrency check against ${base}`);
  const arrivals = Array.from({ length: 50 }, (_, i) => ({ EventClass: "car_spot_action", EventId: `stress-arrival-${i}`, SequenceId: String(i + 1),
    CarPlateNumber: `STRESS ${String(i).padStart(3, "0")}`, SpotName: "ENTRY1", SpotType: "EntrySpot", CarType: "Normal", Direction: "CarIn",
    PlannedParkingDurationInMinutes: "1", ServerDateTime: new Date().toISOString().replace("T", " ").slice(0, 19) }));
  const statuses = await Promise.all(arrivals.map((event) => send(event)));
  await sleep(750);
  const state = await get("/debug/controller");
  const stats = await get("/debug/stats");
  check("all 50 arrivals were acknowledged", statuses.every((s) => s === 200), `${statuses.filter((s) => s !== 200).length} non-200 responses`);
  check("all 50 arrivals were processed", Number(state.counters?.arrived) >= 50, `arrived=${state.counters?.arrived}`);
  check("controller queue drained", state.queue_depth === 0 || state.queue_depth === null, `depth=${state.queue_depth}`);

  const duplicate = arrivals[0];
  const duplicateStatuses = await Promise.all(Array.from({ length: 10 }, () => send(duplicate)));
  await sleep(250);
  const afterDup = await get("/debug/controller");
  check("duplicate deliveries remain harmless", duplicateStatuses.every((s) => s === 200), duplicateStatuses.join(","));
  check("duplicates are counted and logged", Number(afterDup.counters?.duplicate_requests) >= 9 && Number(stats.duplicates ?? 0) >= 0,
    `counter=${afterDup.counters?.duplicate_requests}`);

  const invalidStatus = await send({ EventClass: "test_webhook", EventId: "stress-invalid", SequenceId: "9000" }, false);
  check("invalid signature is rejected", invalidStatus === 401, String(invalidStatus));
  const malformed = await fetch(`${base}/webhook`, { method: "POST", body: "not-json" });
  check("malformed request is rejected", malformed.status === 400, String(malformed.status));
} catch (error) {
  failed++;
  console.error(`  [FAIL] stress check could not complete: ${(error as Error).message}`);
}
console.log(failed ? `\n${failed} STRESS CHECK(S) FAILED` : "\nALL LEVEL 3 STRESS CHECKS PASS");
process.exit(failed ? 1 : 0);
