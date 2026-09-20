import { describe, expect, it } from "vitest";
import { FakeSim, feed, make } from "./helpers";
import type { EventRecord } from "../src/store";

class CoSim extends FakeSim {
  fans: unknown = [{ Name: "FAN1", ZoneParent: "ZONE1", IsRepairRequested: false, IsOn: false }];
  zones: unknown = [{ Name: "ZONE1", CarbonMonoxideLevel: 30, DangerLevel: "Low" }];
  failFanOn = false;
  failFanOff = false;
  zoneReads = 0;

  async listExhaustFans() { return this.fans; }
  async listZones() { this.zoneReads++; return this.zones; }
  async fanOn(name: string) {
    this.calls.push(["fan_on", name]);
    if (this.failFanOn) throw new Error("fan on failed");
  }
  async fanOff(name: string) {
    this.calls.push(["fan_off", name]);
    if (this.failFanOff) throw new Error("fan off failed");
  }
}

function coSim() {
  const base = FakeSim.lvl1();
  return new CoSim(base.spots, base.barriers);
}

let sequence = 0;
function coEvent(input: { level?: string; danger?: string; accepted?: boolean; sig?: string } = {}): EventRecord {
  const id = ++sequence;
  return {
    EventClass: "carbon_monoxide_event", EventId: `co-${id}`, SequenceId: String(id),
    ServerDateTime: "2026-09-20 12:00:00", ZoneName: "ZONE1",
    CarbonMonoxideLevel: input.level ?? "50", DangerLevel: input.danger ?? "Low",
    _received_at: new Date().toISOString(), _accepted: input.accepted ?? true, _sig: input.sig ?? "valid",
  };
}

function fanBroken(): EventRecord {
  const id = ++sequence;
  return { EventClass: "component_broken", EventId: `component-${id}`, Type: "ExhaustFan", Name: "FAN1",
    _received_at: new Date().toISOString(), _accepted: true, _sig: "valid" };
}

describe("Level 2 CO safety controller", () => {
  it("processes accepted events only and triggers on 50 ppm or signed Mid danger", async () => {
    const sim = coSim();
    const { c } = await make({ sim });

    await feed(c, coEvent({ level: "49", accepted: false }));
    expect(c.coSafetySnapshot()).toHaveLength(0);
    expect(sim.calls.filter(([name]) => name === "fan_on")).toHaveLength(0);

    await feed(c, coEvent({ level: "49", danger: "Mid", sig: "unsigned" }));
    expect(c.coSafetySnapshot()[0]).toMatchObject({ ventilationRequired: false, restricted: false });
    expect(sim.calls.filter(([name]) => name === "fan_on")).toHaveLength(0);

    await feed(c, coEvent({ level: "50", danger: "Low" }));
    expect(sim.calls.filter(([name]) => name === "fan_on")).toEqual([["fan_on", "FAN1"]]);
    expect(c.coSafetySnapshot()[0]).toMatchObject({ level: 50, ventilationRequired: true, restricted: false });
  });

  it("restricts admissions for signed High/Critical danger and turns away arrivals", async () => {
    const sim = coSim();
    const { c } = await make({ sim });
    await feed(c, coEvent({ level: "20", danger: "High" }));
    expect(c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationRequired: true });
    await feed(c, {
      EventClass: "car_spot_action", EventId: "entry-co-block", CarPlateNumber: "CO 1", SpotName: "ENTRY1",
      SpotType: "EntrySpot", CarType: "Normal", Direction: "CarIn", PlannedParkingDurationInMinutes: "2",
      ServerDateTime: "2026-09-20 12:00:01", _received_at: new Date().toISOString(), _accepted: true,
    });
    expect(sim.calls.filter(([name]) => name === "goto")).toEqual([["goto", "CO 1", "leavepark"]]);
  });

  it("holds already-queued vehicles during High/Critical CO and resumes after verified recovery", async () => {
    const sim = coSim();
    const { c, advance } = await make({ sim, cfg: { coMinimumVentilationGameS: 5 } });
    const arrival = (plate: string, id: string, direction: "CarIn" | "CarOut") => ({
      EventClass: "car_spot_action", EventId: id, CarPlateNumber: plate, SpotName: "ENTRY1", SpotType: "EntrySpot",
      CarType: "Normal", Direction: direction, PlannedParkingDurationInMinutes: "2",
      ServerDateTime: "2026-09-20 12:00:01", _received_at: new Date().toISOString(),
    } satisfies EventRecord);

    await feed(c, arrival("FIRST", "co-queued-first", "CarIn"), arrival("SECOND", "co-queued-second", "CarIn"));
    expect(c.snapshot().entry_lanes[0].queue).toContain("SECOND");
    await feed(c, coEvent({ level: "60", danger: "High" }));
    await feed(c,
      { EventClass: "gate_action", EventId: "co-queued-gate-open", Name: "gateA", Action: "Open", _received_at: new Date().toISOString() },
      arrival("FIRST", "co-queued-first-out", "CarOut"));

    expect(sim.gotos()).toEqual([["goto", "FIRST", "S1"]]);
    expect(c.snapshot().entry_lanes[0].queue).toContain("SECOND");
    advance(5);
    await expect(c.verifyCoRecovery("ZONE1", "operator")).resolves.toMatchObject({ status: "verified" });
    expect(sim.gotos()).toEqual([["goto", "FIRST", "S1"], ["goto", "SECOND", "S2"]]);
  });

  it("fails closed when inventory is missing, health is unknown, or the fan-on command fails", async () => {
    const noFanSim = coSim();
    noFanSim.fans = [];
    const noFan = await make({ sim: noFanSim });
    await feed(noFan.c, coEvent({ level: "60" }));
    expect(noFan.c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationStartedAtGame: null });

    const unknownHealthSim = coSim();
    unknownHealthSim.fans = [{ Name: "FAN1", ZoneParent: "ZONE1" }];
    const unknownHealth = await make({ sim: unknownHealthSim });
    await feed(unknownHealth.c, coEvent({ level: "60" }));
    expect(unknownHealth.c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationStartedAtGame: null });
    expect(unknownHealthSim.calls.filter(([name]) => name === "fan_on")).toHaveLength(0);

    const failingSim = coSim();
    failingSim.failFanOn = true;
    const failing = await make({ sim: failingSim });
    await feed(failing.c, coEvent({ level: "60" }));
    expect(failing.c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationStartedAtGame: null });
    expect(failing.store.getIncidentByCorrelation("co_safety", "ZONE1")?.severity).toBe("critical");
  });

  it("keeps a zone restricted after a required fan breaks", async () => {
    const sim = coSim();
    const { c, store } = await make({ sim });
    await feed(c, coEvent({ level: "55" }), fanBroken());
    expect(c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationStartedAtGame: null });
    expect(store.getIncidentByCorrelation("co_safety", "ZONE1")?.severity).toBe("critical");
  });

  it("does not query early or recover from unknown/high readings; explicitly verifies below 40", async () => {
    const sim = coSim();
    const { c, store, advance } = await make({ sim, cfg: { coMinimumVentilationGameS: 5 } });
    await feed(c, coEvent({ level: "55", danger: "High" }));

    expect((await c.verifyCoRecovery("ZONE1", "operator-a")).status).toBe("not_ready");
    expect(sim.zoneReads).toBe(0);
    advance(5);

    sim.zones = [{ Name: "ZONE1", DangerLevel: "Low" }];
    expect((await c.verifyCoRecovery("ZONE1", "operator-a")).status).toBe("unavailable");
    expect(c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationStartedAtGame: expect.any(Number) });
    expect(sim.calls.filter(([name]) => name === "fan_off")).toHaveLength(0);

    sim.zones = [{ Name: "ZONE1", CarbonMonoxideLevel: 40, DangerLevel: "Low" }];
    expect((await c.verifyCoRecovery("ZONE1", "operator-a")).status).toBe("unsafe");
    expect(c.coSafetySnapshot()[0].restricted).toBe(true);
    expect(sim.calls.filter(([name]) => name === "fan_off")).toHaveLength(0);

    sim.zones = [{ Name: "ZONE1", CarbonMonoxideLevel: 39, DangerLevel: "Low" }];
    expect(await c.verifyCoRecovery("ZONE1", "operator-a")).toMatchObject({ status: "verified", level: 39 });
    expect(c.coSafetySnapshot()[0]).toMatchObject({ restricted: false, ventilationRequired: false, level: 39 });
    expect(sim.calls.filter(([name]) => name === "fan_off")).toEqual([["fan_off", "FAN1"]]);
    expect(store.listIncidents({ limit: 100 }).find((incident) => incident.type === "co_safety")?.status).toBe("resolved");
  });

  it("restarts fans and preserves restriction if stopping one fails during recovery", async () => {
    const sim = coSim();
    sim.failFanOff = true;
    const { c, advance } = await make({ sim, cfg: { coMinimumVentilationGameS: 2 } });
    await feed(c, coEvent({ level: "60", danger: "Critical" }));
    advance(2);
    const result = await c.verifyCoRecovery("ZONE1", "operator-a");
    expect(result.status).toBe("unavailable");
    expect(sim.calls.filter(([name]) => name === "fan_on")).toHaveLength(2);
    expect(c.coSafetySnapshot()[0]).toMatchObject({ restricted: true, ventilationRequired: true });
  });
});
