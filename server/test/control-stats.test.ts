import { describe, expect, it } from "vitest";
import { carEv, feed, gateEv, testServer } from "./helpers";

const json = { "content-type": "application/json" };

describe("manual control", () => {
  it("holds a gate open against the automation, then hands it back", async () => {
    const { app, signIn, sim, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    const post = (url: string) => app.inject({ method: "POST", url, headers: { cookie } });
    const opened = await post("/api/control/gates/gateA/open");
    expect(opened.json()).toMatchObject({ ok: true });
    expect(sim.last()).toEqual(["open", "gateA"]);
    await controller.handle(gateEv("gateA", "Open"));
    await controller.closeGateIfIdle("gateA"); // what the automation would do
    expect(sim.calls).not.toContainEqual(["close", "gateA"]);
    expect(controller.snapshot().gates.find((g) => g.name === "gateA")!.hold).toBe("open");
    await post("/api/control/gates/gateA/auto");
    expect(sim.last()).toEqual(["close", "gateA"]); // idle, so the automation closes it again
  });
  it("holds a gate closed: arriving cars wait until it is released", async () => {
    const { app, signIn, sim, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    await app.inject({ method: "POST", url: "/api/control/gates/gateA/close", headers: { cookie } });
    await feed(controller, carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls.filter((c) => c[0] === "open")).toEqual([]);
    await app.inject({ method: "POST", url: "/api/control/gates/gateA/auto", headers: { cookie } });
    expect(sim.last()).toEqual(["open", "gateA"]);
  });
  it("refuses what the simulator penalises", async () => {
    const { app, signIn, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    const post = (url: string) => app.inject({ method: "POST", url, headers: { cookie } });
    await feed(controller, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"),
      carEv("A", "ENTRY1", "CarOut", "10:00:02"), carEv("A", "S1", "CarIn", "10:00:05"));
    const occupied = await post("/api/control/spots/S1/repair");
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json().message).toMatch(/occupied by A/);
    expect((await post("/api/control/spots/S2/repair")).json()).toMatchObject({ ok: true });
    expect(controller.spots.get("S2")!.available).toBe(false); // not offered to cars while repaired
    controller.gates.get("gateB")!.broken = true;
    expect((await post("/api/control/gates/gateB/open")).statusCode).toBe(409);
  });
  it("records who issued each manual command", async () => {
    const { app, signIn, store } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    await app.inject({ method: "POST", url: "/api/control/gates/gateA/open", headers: { cookie } });
    const manual = store.searchActions({ manualOnly: true });
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ cmd: "open", args: ["gateA"], actor: "oper", ok: true });
  });
  it("lets an admin close an entrance: arriving cars are turned away", async () => {
    const { app, signIn, sim, controller } = await testServer();
    const cookie = await signIn("admin", "admin-password");
    const res = await app.inject({ method: "POST", url: "/api/control/entries/ENTRY1/close", headers: { cookie } });
    expect(res.json()).toMatchObject({ ok: true });
    await feed(controller, carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.last()).toEqual(["goto", "A", "leavepark"]);
  });
});
describe("statistics", () => {
  it("aggregates visits, revenue and penalties over a window", async () => {
    const { app, signIn, store } = await testServer();
    const now = new Date().toISOString();
    store.recordEvent({ ...carEv("A", "ENTRY1", "CarIn", "10:00:00"), _received_at: now });
    store.recordEvent({ EventClass: "penalty", Reason: "Car is being charged wrongly with amount: (2.00).", FineAmount: "10", EventId: "p1", _received_at: now });
    store.recordSession({ plate: "A", car_type: "Normal", planned_minutes: 3, status: "gone", entry_lane: "ENTRY1", exit_lane: "EXIT_EXIT",
      arrived_at: null, spot: "S1", parked_at: null, left_spot_at: null, exit_at: null, charge_parking: 3, charge_electric: 0,
      charge_attempts: 1, charge_override: null, paid: 3, payment_ok: true, left_at: null, parked_seconds: 180 });
    const cookie = await signIn("oper", "oper-password");
    const stats = (await app.inject({ url: "/api/stats?minutes=60", headers: { cookie } })).json();
    expect(stats.totals).toMatchObject({ arrivals: 1, departures: 1, revenue: 3, avg_ticket: 3, penalties: 1, fines: 10, avg_planned_min: 3 });
    expect(stats.penalties_by_reason[0].reason).toBe("Car is being charged wrongly with amount: (â€¦).");
    expect(stats.spot_usage).toEqual([{ spot: "S1", visits: 1 }]);
    expect(stats.buckets.reduce((n: number, b: { arrivals: number }) => n + b.arrivals, 0)).toBe(1);
  });
});
