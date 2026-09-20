import { describe, expect, it } from "vitest";
import { computeSignature } from "../src/webhook";
import { carEv, FakeSim, feed, fireTimers, gate, make, spot, testServer } from "./helpers";
import type { EventRecord } from "../src/store";

const broken = (type: string, name: string): EventRecord => ({
  EventClass: "component_broken", Type: type, Name: name, Problem: "component failed",
  FineAmount: "20", EventId: `broken-${type}-${name}`, _received_at: "",
});

const level3Topology = {
  name: "test-level3",
  entry_lanes: [{ spot: "ENTRY1", gate: "entry-gate", zone: "ZONE1" }],
  exit_lanes: [{ spot: "EXIT1", gate: "exit-broken", zone: "ZONE1" }, { spot: "EXIT2", gate: "exit-good", zone: "ZONE1" }],
};

function level3Sim() {
  return new FakeSim([
    spot("S1"), spot("S2"), spot("ENTRY1", "EntrySpot", ""), spot("EXIT1", "ExitSpot", "ZONE1"), spot("EXIT2", "ExitSpot", "ZONE1"),
  ], [gate("entry-gate", "Open"), gate("exit-broken", "Closed"), gate("exit-good", "Open")]);
}

describe("Level 3 resilience and control", () => {
  it("quarantines an abnormal parking sensor and exposes a durable incident", async () => {
    const sim = level3Sim();
    const { c, store } = await make({ sim, topo: level3Topology, cfg: { levelProfile: "level3" } });
    await c.handle({ ...broken("ParkingSpotSensor", "S1"), Problem: "sensor abnormality" });
    expect(c.spots.get("S1")?.available).toBe(false);
    expect(c.spots.get("S1")?.maintenance).toBe(true);
    expect(c.components.get("spot", "S1") && c.components.health(c.components.get("spot", "S1")!)).toBe("sensor_abnormal");
    expect(store.listIncidents({ status: "open" }).some((i) => i.kind === "sensor_abnormal")).toBe(true);
  });

  it("clears a sensor alarm when the simulator no longer reports it", async () => {
    const sim = level3Sim();
    sim.alarms = [{ name: "S1", problem: "sensor abnormality" }];
    const { c, store } = await make({ sim, topo: level3Topology, cfg: { levelProfile: "level3" } });
    expect(c.spots.get("S1")?.sensorAbnormal).toBe(true);
    sim.alarms = [];
    await c.sync();
    expect(c.spots.get("S1")?.sensorAbnormal).toBe(false);
    expect(store.listIncidents({ status: "resolved" }).some((i) => i.kind === "sensor_abnormal")).toBe(true);
  });

  it("records both an occupied spot warning and a vehicle in two spots", async () => {
    const { c, store } = await make({ sim: level3Sim(), topo: level3Topology, cfg: { levelProfile: "level3" } });
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    c.cars.get("A")!.assigned_spot = "S1";
    await c.handle(carEv("B", "S1", "CarIn", "10:00:01"));
    await c.handle(carEv("A", "S2", "CarIn", "10:00:02"));
    expect(c.spots.get("S1")?.occupants).toEqual(new Set(["A", "B"]));
    expect(c.spots.get("S2")?.occupants).toEqual(new Set(["A"]));
    expect(store.listIncidents({ status: "open" }).map((i) => i.kind)).toEqual(expect.arrayContaining(["double_parking", "vehicle_multiple_spots"]));
    expect(store.listVehicleLocations({ plate: "A" }).some((l) => l.location === "spot:S2" && l.assigned_spot === "S1")).toBe(true);
  });

  it("reroutes a paid car to a healthy exit when its assigned gate fails", async () => {
    const { c, sim, store } = await make({ sim: level3Sim(), topo: level3Topology, cfg: { levelProfile: "level3" } });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarOut", "10:00:01"), carEv("A", "S1", "CarIn", "10:00:02"), carEv("A", "S1", "CarOut", "10:02:02"), carEv("A", "EXIT1", "CarIn", "10:02:03"));
    await fireTimers(c);
    await c.handle(broken("BarrierGate", "exit-broken"));
    await c.handle({ EventClass: "payment_made", CarPlateNumber: "A", Amount: "2.00", Reason: "Car Payment", EventId: "pay-a", _received_at: "" });
    expect(sim.gotos()).toContainEqual(["goto", "A", "EXIT2"]);
    expect(c.counters.gate_failovers).toBe(1);
    expect(store.listIncidents({ status: "open" }).some((i) => i.kind === "gate_failover")).toBe(true);
  });

  it("keeps duplicate and tampered webhook requests visible under concurrent delivery", async () => {
    const { app, store, signIn } = await testServer({ cfg: { signatureMode: "strict", levelProfile: "level3" } });
    await signIn("admin", "admin-password");
    const unsignedPayload = { EventClass: "test_webhook", EventId: "same-event", SequenceId: "1" };
    const signed = JSON.stringify({ ...unsignedPayload, Signature: computeSignature(unsignedPayload) });
    const duplicates = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: signed })));
    expect(duplicates.filter((r) => r.statusCode === 200)).toHaveLength(20);
    const invalid = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ EventClass: "test_webhook", EventId: "invalid-event", Signature: "0".repeat(32) }) });
    expect(invalid.statusCode).toBe(401);
    const tampered = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ EventClass: "test_webhook", EventId: "same-event", SequenceId: "1", Signature: "0".repeat(32), value: "tampered" }) });
    expect(tampered.statusCode).toBe(409);
    const security = store.listSecurityEvents({ limit: 100 });
    expect(security.filter((e) => e.decision === "accepted")).toHaveLength(1);
    expect(security.filter((e) => e.decision === "duplicate")).toHaveLength(19);
    expect(security.filter((e) => e.decision === "invalid_signature")).toHaveLength(1);
    expect(security.some((e) => e.decision === "conflict")).toBe(true);
    expect(store.listIncidents({ status: "open" }).some((i) => i.kind === "event_id_conflict")).toBe(true);

    const missingId = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ EventClass: "test_webhook", Signature: computeSignature({ EventClass: "test_webhook" }) }) });
    expect(missingId.statusCode).toBe(400);
    expect(store.listSecurityEvents({ decision: "malformed" }).some((e) => e.reason.includes("EventId"))).toBe(true);
  });
});
