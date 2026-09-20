import { describe, expect, it } from "vitest";
import { FakeSim, feed, gateEv, make, carEv, twoZoneSim, TWO_ZONES } from "./helpers";
import type { EventRecord } from "../src/store";

class EquipmentSim extends FakeSim {
  constructor(spots = FakeSim.lvl1().spots, barriers = FakeSim.lvl1().barriers, public fans: unknown[] = [], public lights: unknown[] = []) {
    super(spots, barriers);
  }
  async listExhaustFans() { return this.fans; }
  async listLights() { return this.lights; }
  async fanOn(name: string) { this.calls.push(["fan_on", name]); }
  async fanOff(name: string) { this.calls.push(["fan_off", name]); }
  async repairFan(name: string) { this.calls.push(["repair_fan", name]); }
}

function componentEvent(kind: string, name: string, state: "broken" | "fixed", sequence?: number): EventRecord {
  return { EventClass: state === "broken" ? "component_broken" : "component_fixed", Type: kind, Name: name,
    ...(sequence === undefined ? {} : { SequenceId: String(sequence) }), EventId: `${kind}-${name}-${state}-${sequence ?? "none"}`,
    _received_at: new Date().toISOString(), _accepted: true, _sig: "valid" };
}

describe("Level 2 equipment safety and maintenance", () => {
  it("does not mutate a same-named spot for a light or unknown component event", async () => {
    const { c, store } = await make();
    await feed(c, componentEvent("Light", "S1", "broken"), componentEvent("UnexpectedThing", "S1", "broken"));
    expect(c.spots.get("S1")?.broken).toBe(false);
    expect(store.listIncidents({ limit: 100 }).some((incident) => incident.type === "component_unavailable" && incident.component_type === "light")).toBe(true);
    expect(store.listIncidents({ limit: 100 }).some((incident) => incident.type === "unknown_component_event")).toBe(true);
  });

  it("ignores an older component-fixed event after a newer broken signal", async () => {
    const { c } = await make({ cfg: { webhookProfile: "level2" } });
    await feed(c, componentEvent("BarrierGate", "gateA", "broken", 20), componentEvent("BarrierGate", "gateA", "fixed", 19));
    expect(c.gates.get("gateA")?.broken).toBe(true);
  });

  it("drains only the affected gate, completes its active crossing, then repairs after close confirmation", async () => {
    const { c, sim, store } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("DRAIN A", "ENTRY1", "CarIn", "10:00:00"),
      carEv("DRAIN B", "ENTRY1", "CarIn", "10:00:01"));
    const job = store.createMaintenanceJob({ componentType: "gate", component: "gateA", zone: "ZONE1",
      requestedBy: "tech", reason: "scheduled gate service" });

    const started = await c.manualGate("gateA", "repair", "tech", job.reason, job.id);
    expect(started.ok).toBe(true);
    expect(c.gates.get("gateA")?.draining).toBe(true);
    expect(sim.calls.some(([name]) => name === "repair")).toBe(false);

    await c.handle(carEv("DRAIN C", "ENTRY1", "CarIn", "10:00:02"));
    expect(sim.gotos()).toContainEqual(["goto", "DRAIN C", "leavepark"]);
    await c.handle(carEv("DRAIN A", "ENTRY1", "CarOut", "10:00:03"));
    expect(sim.gotos().some((call) => call[1] === "DRAIN B")).toBe(false);
    await c.tick();
    expect(sim.calls).toContainEqual(["close", "gateA"]);
    expect(sim.calls.some(([name]) => name === "repair")).toBe(false);

    await c.handle(gateEv("gateA", "Closed"));
    await c.tick();
    expect(sim.calls).toContainEqual(["repair", "gateA"]);
    expect(c.gates.get("gateA")).toMatchObject({ draining: true, maintenance: true });
  });

  it("keeps a separate zone operating while a gate drains", async () => {
    const sim = twoZoneSim();
    const { c, store } = await make({ sim, topo: TWO_ZONES });
    await feed(c, gateEv("g1", "Open"), gateEv("g3", "Open"), carEv("ZONE1 A", "ENTRY1", "CarIn", "10:00:00"));
    const job = store.createMaintenanceJob({ componentType: "gate", component: "g1", zone: "ZONE1",
      requestedBy: "tech", reason: "scheduled gate service" });
    expect((await c.manualGate("g1", "repair", "tech", job.reason, job.id)).ok).toBe(true);
    expect(c.gates.get("g1")?.draining).toBe(true);

    await c.handle(carEv("ZONE2 B", "ENTRY2", "CarIn", "10:00:01"));
    expect(sim.gotos()).toContainEqual(["goto", "ZONE2 B", "S3"]);
    expect(c.gates.get("g3")?.draining).toBe(false);
  });

  it("allows a failed fan repair during CO ventilation only when a fresh healthy running backup exists", async () => {
    const sim = new EquipmentSim(undefined, undefined, [
      { Name: "FAN1", ZoneParent: "ZONE1", IsOn: false, IsRepairRequested: false },
      { Name: "FAN2", ZoneParent: "ZONE1", IsOn: true, IsRepairRequested: false },
    ]);
    const { c, store } = await make({ sim });
    await feed(c, { EventClass: "carbon_monoxide_event", EventId: "co-equip", SequenceId: "40", ZoneName: "ZONE1",
      CarbonMonoxideLevel: "55", DangerLevel: "High", _received_at: new Date().toISOString(), _accepted: true, _sig: "valid" },
    componentEvent("ExhaustFan", "FAN1", "broken", 41));

    const result = await c.manualFanRepair("FAN1", "tech", "replace failed fan");
    expect(result.ok).toBe(true);
    expect(sim.calls).toContainEqual(["repair_fan", "FAN1"]);
    await c.handle(componentEvent("ExhaustFan", "FAN1", "fixed", 42));
    expect(store.listMaintenanceJobs().find((job) => job.component === "FAN1")?.status).toBe("completed");
  });

  it("does not repair the only required fan while the zone needs ventilation", async () => {
    const sim = new EquipmentSim(undefined, undefined, [
      { Name: "FAN1", ZoneParent: "ZONE1", IsOn: false, IsRepairRequested: false },
    ]);
    const { c } = await make({ sim });
    await feed(c, { EventClass: "carbon_monoxide_event", EventId: "co-only", SequenceId: "50", ZoneName: "ZONE1",
      CarbonMonoxideLevel: "60", DangerLevel: "Critical", _received_at: new Date().toISOString(), _accepted: true, _sig: "valid" },
    componentEvent("ExhaustFan", "FAN1", "broken", 51));
    const result = await c.manualFanRepair("FAN1", "tech", "replace failed fan");
    expect(result.ok).toBe(false);
    expect(sim.calls.some(([name]) => name === "repair_fan")).toBe(false);
  });
});
