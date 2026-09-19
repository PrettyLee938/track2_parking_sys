import { describe, expect, it } from "vitest";
import { computeSignature } from "../src/webhook";
import { carEv, fireTimers, make, parkAndReachExit, payEv, threeZoneSim, THREE_ZONES, twoZoneSim, TWO_ZONES } from "./helpers";
import type { EventRecord } from "../src/store";
import { SimError } from "../src/simClient";

const event = (e: EventRecord): EventRecord => ({ ...e, EventId: e.EventId ?? `l2-${Math.random()}`, Signature: computeSignature(e) });

describe("Level 2 deterministic simulator acceptance", () => {
  it("accepts compatible cars concurrently in all three zones", async () => {
    const sim = threeZoneSim();
    const { c } = await make({ sim, topo: THREE_ZONES, cfg: { gameSpeed: 1, closeIdleGatesOnSync: false } });
    await c.handle(carEv("NORMAL", "ENTRY1", "CarIn", "12:00:00", "3", "Normal"));
    await c.handle(carEv("ACCESS", "ENTRY2", "CarIn", "12:00:01", "3", "Accessible"));
    await c.handle(carEv("ELECTRIC", "ENTRY3", "CarIn", "12:00:02", "3", "Electric"));
    expect(sim.gotos()).toEqual(expect.arrayContaining([["goto", "NORMAL", "S1"], ["goto", "ACCESS", "S2"], ["goto", "ELECTRIC", "S3"]]));
    await c.handle(carEv("NORMAL", "S1", "CarIn", "12:00:10", "3", "Normal"));
    await c.handle(carEv("ACCESS", "S2", "CarIn", "12:00:11", "3", "Accessible"));
    await c.handle(carEv("ELECTRIC", "S3", "CarIn", "12:00:12", "3", "Electric"));
    expect(c.snapshot().zones).toMatchObject({ ZONE1: { occupied: 1 }, ZONE2: { occupied: 1 }, ZONE3: { occupied: 1 } });
  });

  it("keeps healthy zones operating while high CO restricts only the affected zone", async () => {
    const sim = twoZoneSim();
    sim.fans = [
      { name: "fan1", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: false },
      { name: "fan2", zoneParent: "ZONE2", broken: false, isUnderMaintenance: false, isOn: false },
    ];
    sim.listZones = async () => [
      { name: "ZONE1", gasCarbonMonoxideLevel: 0, risk: "Safe" },
      { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" },
    ];
    const { c, sim: fake, advance } = await make({ sim, topo: TWO_ZONES, cfg: {
      gameSpeed: 1, ventilationMinGameS: 2, ventilationRecoveryGameS: 0, closeIdleGatesOnSync: false,
    } });
    await c.handle(event({ EventClass: "carbon_monoxide_event", ZoneName: "ZONE1", CarbonMonoxideLevel: "72", DangerLevel: "High", ServerDateTime: "2026-09-20 20:00:00", _received_at: new Date().toISOString() }));
    expect(fake.calls).toContainEqual(["fan-on", "fan1"]);
    expect(c.snapshot().environment?.zones.find((z) => z.zone === "ZONE1")?.restricted).toBe(true);
    expect(c.snapshot().environment?.zones.find((z) => z.zone === "ZONE2")?.restricted).toBe(false);

    fake.listZones = async () => [
      { name: "ZONE1", gasCarbonMonoxideLevel: 20, risk: "Safe" },
      { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" },
    ];
    advance(3);
    await fireTimers(c);
    expect(fake.calls).toContainEqual(["fan-off", "fan1"]);
    expect(c.snapshot().environment?.zones.find((z) => z.zone === "ZONE1")?.restricted).toBe(false);
  });

  it("starts recovery verification for a high-CO zone discovered during startup", async () => {
    const sim = twoZoneSim();
    sim.fans = [{ name: "fan1", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: false }];
    let safe = false;
    sim.listZones = async () => safe
      ? [{ name: "ZONE1", gasCarbonMonoxideLevel: 10, risk: "Safe" }]
      : [{ name: "ZONE1", gasCarbonMonoxideLevel: 70, risk: "High" }];
    const { c, advance } = await make({ sim, topo: TWO_ZONES, cfg: {
      gameSpeed: 1, ventilationMinGameS: 2, ventilationRecoveryGameS: 0, closeIdleGatesOnSync: false,
    } });
    expect(c.snapshot().environment?.zones.find((z) => z.zone === "ZONE1")?.restricted).toBe(true);
    safe = true;
    advance(3);
    await fireTimers(c);
    expect(sim.calls).toContainEqual(["fan-off", "fan1"]);
    expect(c.snapshot().environment?.zones.find((z) => z.zone === "ZONE1")?.restricted).toBe(false);
  });

  it("holds one exit passage owner and does not bill an unknown manually parked visit", async () => {
    const { c, sim } = await make({ cfg: { gameSpeed: 1, closeIdleGatesOnSync: false } });
    await c.handle(carEv("UNKNOWN", "EXIT_EXIT", "CarIn", "20:00:00", "0"));
    expect(c.cars.get("UNKNOWN")?.status).toBe("unknown");
    expect(sim.charges()).toHaveLength(0);
    const review = await c.reviewUnknownVisit("UNKNOWN", 4, "operator verified the parking ticket", "oper");
    expect(review.ok).toBe(true);
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1);
    expect(c.cars.get("UNKNOWN")?.billing_basis).toBe("operator-approved duration");
  });

  it("counts only accepted event effects after rejected deliveries and survives durable duplicate checks", async () => {
    const sim = twoZoneSim();
    const { app, store, signIn } = await (await import("./helpers")).testServer({ sim, cfg: { levelProfile: "level2", signatureMode: "lenient" } });
    const cookie = await signIn("admin", "admin-password");
    const payload = { EventClass: "test_webhook", EventId: "stable-1", SequenceId: "1" };
    const signed = { ...payload, Signature: computeSignature(payload) };
    expect((await app.inject({ method: "POST", url: "/webhook", headers: { cookie, "content-type": "application/json" }, payload: JSON.stringify(signed) })).statusCode).toBe(200);
    const duplicate = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: JSON.stringify(signed) });
    expect(duplicate.statusCode).toBe(200);
    const tampered = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: JSON.stringify({ ...payload, EventId: "stable-2", Signature: "0".repeat(32) }) });
    expect(tampered.statusCode).toBe(401);
    expect(store.db.prepare("SELECT count(*) n FROM events WHERE accepted = 1").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT count(*) n FROM events WHERE accepted = 0").get()).toEqual({ n: 2 });
  });

  it("does not let an invalid delivery reserve an EventId", async () => {
    const { app, store, queue } = await (await import("./helpers")).testServer({ cfg: { levelProfile: "level2" } });
    const body = { EventClass: "test_webhook", EventId: "reusable-id", SequenceId: 1 };
    const rejected = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...body, Signature: "0".repeat(32) }) });
    expect(rejected.statusCode).toBe(401);
    const signedBody = { ...body, Signature: computeSignature(body) };
    const accepted = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: JSON.stringify(signedBody) });
    expect(accepted.statusCode).toBe(200);
    expect(queue.tasks).toHaveLength(1);
    expect(store.db.prepare("SELECT count(*) n FROM event_identities WHERE event_id = 'reusable-id'").get()).toEqual({ n: 1 });
  });

  it("settles a persisted invoice after a lost charge response without retrying", async () => {
    const { c, sim } = await make({ cfg: { gameSpeed: 1, closeIdleGatesOnSync: false } });
    sim.carCharge = async (plate, parking, electric) => {
      sim.calls.push(["charge", plate, parking, electric]);
      throw new SimError("charge response lost", true);
    };
    await parkAndReachExit(c, "UNCERTAIN");
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1);
    await c.handle(payEv("UNCERTAIN", 2));
    expect(c.cars.get("UNCERTAIN")?.payment_ok).toBe(true);
    expect(sim.charges()).toHaveLength(1);
  });

  it("keeps a settled visit released when a later fake payment arrives", async () => {
    const { c, sim } = await make({ cfg: { gameSpeed: 1, closeIdleGatesOnSync: false } });
    await parkAndReachExit(c, "FAKEPAY");
    await fireTimers(c);
    await c.handle(payEv("FAKEPAY", 2));
    await c.handle(payEv("FAKEPAY", 99));
    expect(c.cars.get("FAKEPAY")?.payment_ok).toBe(true);
    expect(c.cars.get("FAKEPAY")?.status).toBe("released");
    expect(sim.charges()).toHaveLength(1);
    expect(c.store.listIncidents({ status: "open" }).some((x) => x.kind === "payment_after_settlement")).toBe(true);
  });
});
