/**
 * Parking-spot sensor health and maintenance mode (Level 3 §7.2).
 *
 * The cost of getting this wrong is asymmetric, and the tests are written around that:
 * trusting a bad sensor earns "attempted to park in an occupied spot" for every car sent
 * there afterwards, while locking a good spot only costs a little capacity. So the
 * detectors are allowed to be cautious, but they must let a spot back when it reads clean
 * and must never lock out most of a zone.
 */
import { describe, expect, it } from "vitest";
import type { SpotSensorSnapshot } from "@gpa/shared";
import { FakeSim, carEv, make, spot } from "./helpers";
import type { Controller } from "../src/controller";

const sensors = (c: Controller) => c.snapshot().subsystems.spot_sensors as SpotSensorSnapshot;
const faultOn = (c: Controller, name: string) => sensors(c).spots.find((f) => f.spot === name);
const incidents = (c: Controller) => c.store.listIncidents({ limit: 50 }).filter((i) => i.kind === "spot_sensor_fault");

/** Make the simulator report `detected` cars in a spot, then resync. */
async function sensorSays(c: Controller, sim: FakeSim, name: string, detected: number) {
  sim.spots = sim.spots.map((s) => (s.name === name ? { ...s, detectedCars: detected } : s));
  await c.sync();
}

describe("spot sensor abnormalities", () => {
  it("does nothing at all when the watch is off", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "off" } });
    await sensorSays(c, sim, "S1", 1);
    await sensorSays(c, sim, "S1", 1);
    expect(sensors(c)).toMatchObject({ mode: "off", faults: 0 });
    expect(incidents(c)).toHaveLength(0);
  });

  it("flags a ghost only after it has held across several syncs", async () => {
    // One reading of a car we cannot name is a car we lost track of - the controller
    // already marks the spot occupied for it. Two in a row with no arrival is a sensor.
    const { c, sim } = await make({ cfg: { spotSensorMode: "maintenance", spotGhostSyncs: 2 } });
    await sensorSays(c, sim, "S1", 1);
    expect(faultOn(c, "S1")).toBeUndefined();
    await sensorSays(c, sim, "S1", 1);
    expect(faultOn(c, "S1")).toMatchObject({ signal: "ghost", locked: true });
    expect(c.spots.get("S1")!.available).toBe(false);
    expect(c.spots.get("S1")!.out_of_service).toMatch(/ghost/);
  });

  it("records an incident and a maintenance job with the evidence", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "maintenance" } });
    await sensorSays(c, sim, "S1", 1);
    await sensorSays(c, sim, "S1", 1);
    const [incident] = incidents(c);
    expect(incident).toMatchObject({ kind: "spot_sensor_fault", component: "S1", status: "open", confidence: "high" });
    expect(incident.evidence).toMatchObject({ signal: "ghost", detected: 1 });
    const job = c.store.listMaintenanceJobs(10).find((j) => j.component_name === "S1");
    expect(job).toMatchObject({ component_kind: "spot", status: "scheduled" });
    expect(c.store.listAudit(20).some((a) => a.action === "spot.sensor_fault" && a.target === "S1")).toBe(true);
  });

  it("puts the spot back once the sensor reads clean again, and resolves the incident", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "maintenance", spotSensorClearSyncs: 2 } });
    await sensorSays(c, sim, "S1", 1);
    await sensorSays(c, sim, "S1", 1);
    expect(c.spots.get("S1")!.out_of_service).toBeTruthy();
    await sensorSays(c, sim, "S1", 0);
    expect(c.spots.get("S1")!.out_of_service).toBeTruthy(); // one clean sync is not enough
    await sensorSays(c, sim, "S1", 0);
    expect(c.spots.get("S1")!.out_of_service).toBeNull();
    expect(c.spots.get("S1")!.available).toBe(true);
    expect(incidents(c)[0]).toMatchObject({ status: "resolved", resolved_by: "system" });
  });

  it("records the fault but keeps the spot in use in watch mode", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "watch" } });
    await sensorSays(c, sim, "S1", 1);
    await sensorSays(c, sim, "S1", 1);
    expect(faultOn(c, "S1")).toMatchObject({ signal: "ghost", locked: false });
    expect(c.spots.get("S1")!.out_of_service).toBeNull();
    expect(incidents(c)).toHaveLength(1);
  });

  it("flags a sensor that counts more cars than ever arrived", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "maintenance" } });
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    await sensorSays(c, sim, "S1", 3); // one car arrived, the sensor sees three
    expect(faultOn(c, "S1")).toMatchObject({ signal: "over_count" });
    expect(incidents(c)[0].evidence).toMatchObject({ detected: 3, car_ins: 1 });
  });

  it("leaves a sensor alone when two cars really did arrive - that is double parking, not a fault", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "maintenance" } });
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    await c.handle(carEv("B", "S1", "CarIn", "10:00:05"));
    await sensorSays(c, sim, "S1", 2);
    expect(faultOn(c, "S1")).toBeUndefined();
  });

  it("flags a sensor that flips faster than cars can move", async () => {
    const { c } = await make({ cfg: { spotSensorMode: "maintenance", spotFlapMax: 4, spotFlapWindowGameS: 60, gameSpeed: 1 } });
    for (let i = 0; i < 5; i++) {
      await c.handle(carEv("A", "S1", i % 2 === 0 ? "CarIn" : "CarOut", "10:00:00"));
    }
    expect(faultOn(c, "S1")).toMatchObject({ signal: "flapping" });
  });

  it("flags a sensor whose cars keep turning up somewhere else", async () => {
    // "A spot that never reports the car we sent to it": the car parks, just not here.
    const { c } = await make({ cfg: { spotSensorMode: "maintenance", spotSilentMisses: 2, gameSpeed: 1 } });
    for (const plate of ["A", "B"]) {
      await c.handle(carEv(plate, "ENTRY1", "CarIn", "10:00:00"));
      const sent = c.cars.get(plate)!.spot!;
      const elsewhere = ["S1", "S2", "S3"].find((s) => s !== sent)!;
      await c.handle(carEv(plate, "ENTRY1", "CarOut", "10:00:02"));
      await c.handle(carEv(plate, elsewhere, "CarIn", "10:00:05"));
      expect(sent).not.toBe(elsewhere);
    }
    expect(sensors(c).spots.some((f) => f.signal === "silent")).toBe(true);
  });

  it("never locks out most of a zone on suspicion", async () => {
    // A wrong sensor costs one penalty; a zone nobody is sent to costs every arrival.
    const sim = new FakeSim(
      [spot("S1"), spot("S2"), spot("S3"), spot("S4"), spot("ENTRY1", "EntrySpot", ""), spot("EXIT_EXIT", "ExitSpot")],
      [{ name: "gateA", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Closed" },
        { name: "gateB", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Open" }],
    );
    const { c } = await make({ sim, cfg: { spotSensorMode: "maintenance", spotSensorMaxLockedRatio: 0.25 } });
    for (const name of ["S1", "S2", "S3"]) {
      await sensorSays(c, sim, name, 1);
      await sensorSays(c, sim, name, 1);
    }
    const locked = [...c.spots.values()].filter((s) => s.out_of_service !== null);
    expect(locked).toHaveLength(1);                 // 25% of 4 spots
    expect(sensors(c).faults).toBe(3);              // all three are still reported
    expect(c.feed.some((f) => f.msg.includes("already out of service"))).toBe(true);
  });
});

describe("operator control of a spot's service state", () => {
  it("takes a spot out of service and puts it back, with an audit trail", async () => {
    const { c } = await make({ cfg: { spotSensorMode: "maintenance" } });
    const out = await c.setSpotService("S1", false, "oper", "sensor looks wrong");
    expect(out.ok).toBe(true);
    expect(c.spots.get("S1")!.available).toBe(false);
    expect(incidents(c)[0]).toMatchObject({ component: "S1", confidence: "high" });

    const back = await c.setSpotService("S1", true, "oper", "checked on site");
    expect(back.ok).toBe(true);
    expect(c.spots.get("S1")!.available).toBe(true);
    const actions = c.store.listAudit(20).map((a) => a.action);
    expect(actions).toContain("spot.out_of_service");
    expect(actions).toContain("spot.back_in_service");
  });

  it("refuses to take an occupied spot out of service - the car in it would be stranded", async () => {
    const { c } = await make({ cfg: { spotSensorMode: "maintenance" } });
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    const result = await c.setSpotService("S1", false, "oper", "");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/occupied|reserved/);
    expect(c.spots.get("S1")!.out_of_service).toBeNull();
  });

  it("reports an unknown spot rather than pretending", async () => {
    const { c } = await make({ cfg: { spotSensorMode: "maintenance" } });
    expect(await c.setSpotService("nope", false, "oper", "")).toMatchObject({ ok: false });
  });

  it("stops offering an out-of-service spot to arriving cars", async () => {
    const { c, sim } = await make({ cfg: { spotSensorMode: "maintenance" } });
    await c.setSpotService("S1", false, "oper", "sensor not trusted");
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(c.cars.get("A")!.spot).not.toBe("S1");
    expect(sim.gotos().some((g) => g[2] === "S1")).toBe(false);
  });
});

describe("the spots API", () => {
  it("shows why a spot is out of service in the snapshot", async () => {
    const { c } = await make({ cfg: { spotSensorMode: "maintenance" } });
    await c.setSpotService("S2", false, "oper", "sensor not trusted");
    const view = c.snapshot().spots.find((s) => s.name === "S2")!;
    expect(view).toMatchObject({ available: false, out_of_service: "sensor not trusted" });
    expect(c.snapshot().zones.ZONE1.out_of_service).toBe(0); // the simulator still calls it healthy
  });
});
