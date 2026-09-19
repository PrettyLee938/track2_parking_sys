/**
 * Unattended Level 2 simulator replay.
 *
 * This drives the same controller path as the live webhook listener with a deterministic
 * simulator double, then writes a compact pass/fail log. It is intentionally small enough
 * to run before every live Level 2 session and exercises the failure modes that cannot be
 * safely manufactured in the real parking simulator.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { carEv, fireTimers, make, parkAndReachExit, payEv, threeZoneSim, THREE_ZONES, twoZoneSim, TWO_ZONES } from "../test/helpers";
import { REPO_ROOT } from "../src/config";
import { SimError } from "../src/simClient";

const logFile = path.join(REPO_ROOT, "logs", "level2-acceptance.log");
mkdirSync(path.dirname(logFile), { recursive: true });
const lines: string[] = [];
const log = (message: string) => { lines.push(`${new Date().toISOString()} ${message}`); console.log(message); };
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}`);
  if (!ok) throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

async function main() {
  log("Level 2 acceptance replay started");
  const three = threeZoneSim();
  const threeRun = await make({ sim: three, topo: THREE_ZONES, cfg: { gameSpeed: 1, closeIdleGatesOnSync: false } });
  await threeRun.c.handle(carEv("NORMAL", "ENTRY1", "CarIn", "12:00:00", "3", "Normal"));
  await threeRun.c.handle(carEv("ACCESS", "ENTRY2", "CarIn", "12:00:01", "3", "Accessible"));
  await threeRun.c.handle(carEv("ELECTRIC", "ENTRY3", "CarIn", "12:00:02", "3", "Electric"));
  check("three zones accept compatible traffic", three.gotos().length, 3);
  await threeRun.c.handle(carEv("NORMAL", "S1", "CarIn", "12:00:10", "3", "Normal"));
  await threeRun.c.handle(carEv("ACCESS", "S2", "CarIn", "12:00:11", "3", "Accessible"));
  await threeRun.c.handle(carEv("ELECTRIC", "S3", "CarIn", "12:00:12", "3", "Electric"));
  check("three zones report occupied cars", Object.values(threeRun.c.snapshot().zones).map((z) => z.occupied), [1, 1, 1]);

  const lightSim = twoZoneSim();
  lightSim.lights = [
    { name: "z1-light", group: "SHARED", zoneParent: "ZONE1", isOn: false },
    { name: "z2-light", group: "SHARED", zoneParent: "ZONE2", isOn: false },
  ];
  const lightRun = await make({ sim: lightSim, topo: TWO_ZONES, cfg: { gameSpeed: 1, lightClearanceGameS: 2, closeIdleGatesOnSync: false } });
  await lightRun.c.handle(carEv("LIGHT-Z1", "ENTRY1", "CarIn", "20:00:00"));
  check("night lights follow the moving zone", [
    lightRun.c.components.get("light", "z1-light")?.on,
    lightRun.c.components.get("light", "z2-light")?.on,
  ], [true, false]);
  check("night light command precedes entry gate dispatch",
    lightSim.calls.findIndex((x) => x[0] === "light-on" && x[1] === "z1-light") <
      lightSim.calls.findIndex((x) => x[0] === "open" && x[1] === "g1"), true);
  log(`TRACE light night/z1: ${JSON.stringify(lightSim.calls.filter((x) => x[0].includes("light") || x[0].includes("group")))}`);
  await lightRun.c.handle(carEv("LIGHT-Z2", "ENTRY2", "CarIn", "20:00:01"));
  check("shared group can light a second moving zone independently", [
    lightRun.c.components.get("light", "z1-light")?.on,
    lightRun.c.components.get("light", "z2-light")?.on,
  ], [true, true]);
  await lightRun.c.handle(carEv("LIGHT-Z1", "S1", "CarIn", "20:00:02"));
  await lightRun.c.handle(carEv("LIGHT-Z2", "S3", "CarIn", "20:00:02"));
  lightRun.advance(3);
  await fireTimers(lightRun.c);
  check("night lights clear after traffic stops", [
    lightRun.c.components.get("light", "z1-light")?.on,
    lightRun.c.components.get("light", "z2-light")?.on,
  ], [false, false]);
  await lightRun.c.handle({ EventClass: "test_event", EventId: "light-day", ServerDateTime: "2026-09-20 12:00:00", _received_at: "" });
  check("day policy is recorded", lightRun.c.snapshot().environment?.zones.every((z) => z.nighttime === false), true);
  log(`TRACE light policy/feed: ${JSON.stringify(lightRun.c.feed.filter((f) => f.msg.startsWith("light ")))}`);

  const sim = twoZoneSim();
  sim.fans = [{ name: "fan1", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: false }];
  sim.listZones = async () => [{ name: "ZONE1", gasCarbonMonoxideLevel: 0, risk: "Safe" }, { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" }];
  const { c, advance } = await make({ sim, topo: TWO_ZONES, cfg: { gameSpeed: 1, ventilationMinGameS: 2, ventilationRecoveryGameS: 0, closeIdleGatesOnSync: false } });

  await c.handle({ EventClass: "carbon_monoxide_event", ZoneName: "ZONE1", CarbonMonoxideLevel: "80", DangerLevel: "High", EventId: "co-1", _received_at: new Date().toISOString() });
  check("high CO starts ventilation", sim.calls.some((x) => x[0] === "fan-on" && x[1] === "fan1"), true);
  check("high CO restricts only its zone", c.snapshot().environment?.zones.find((z) => z.zone === "ZONE1")?.restricted, true);

  sim.listZones = async () => [{ name: "ZONE1", gasCarbonMonoxideLevel: 10, risk: "Safe" }, { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" }];
  advance(3);
  await fireTimers(c);
  check("fresh safe reading stops ventilation", sim.calls.some((x) => x[0] === "fan-off" && x[1] === "fan1"), true);

  await c.handle(carEv("MANUAL-1", "EXIT_EXIT", "CarIn", "20:00:00", "0"));
  check("unknown visit is held", c.cars.get("MANUAL-1")?.status, "unknown");
  check("unknown visit is not billed", sim.calls.filter((x) => x[0] === "charge").length, 0);
  await c.reviewUnknownVisit("MANUAL-1", 3, "ticket and operator observation", "operator");
  await fireTimers(c);
  check("reviewed visit gets one invoice", sim.calls.filter((x) => x[0] === "charge").length, 1);

  const uncertain = twoZoneSim();
  const uncertainRun = await make({ sim: uncertain, topo: TWO_ZONES, cfg: { gameSpeed: 1, closeIdleGatesOnSync: false } });
  uncertain.carCharge = async (plate, parking, electric) => {
    uncertain.calls.push(["charge", plate, parking, electric]);
    throw new SimError("charge response lost", true);
  };
  await parkAndReachExit(uncertainRun.c, "UNCERTAIN");
  await fireTimers(uncertainRun.c);
  await uncertainRun.c.handle({ ...payEv("UNCERTAIN", 2), EventId: "payment-uncertain" });
  check("lost charge response is settled without a duplicate charge", [uncertain.charges().length, uncertainRun.c.cars.get("UNCERTAIN")?.payment_ok], [1, true]);
  log("Level 2 acceptance replay complete");
  appendFileSync(logFile, lines.join("\n") + "\n", "utf8");
}

main().catch((err) => {
  log(`FAIL harness: ${(err as Error).stack ?? err}`);
  appendFileSync(logFile, lines.join("\n") + "\n", "utf8");
  process.exitCode = 1;
});
