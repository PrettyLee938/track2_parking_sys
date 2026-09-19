import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
describe("lifecycle", () => {
  it("runs a car from arrival to departure", async () => {
    const { c, sim } = await make();
    await c.handle(carEv("AAA 1", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls).toEqual([["open", "gateA"]]); // waits for Open before goto
    await c.handle(gateEv("gateA", "Open"));
    expect(sim.last()).toEqual(["goto", "AAA 1", "S1"]);
    expect(c.spots.get("S1")!.reserved_for).toBe("AAA 1");
    await feed(c, carEv("AAA 1", "ENTRY1", "CarOut", "10:00:02"), carEv("AAA 1", "S1", "CarIn", "10:00:05"));
    expect(c.spots.get("S1")!.occupant).toBe("AAA 1");
    expect(c.spots.get("S1")!.reserved_for).toBeNull();
    await feed(c, carEv("AAA 1", "S1", "CarOut", "10:02:07"), carEv("AAA 1", "EXIT_EXIT", "CarIn", "10:02:15", "0"));
    expect(sim.charges()).toEqual([]); // not the instant it arrives
    await fireTimers(c);
    expect(sim.last()).toEqual(["charge", "AAA 1", 2, 0]); // planned 2 minutes
    await c.handle(carEv("AAA 1", "EXIT_EXIT", "CarIn", "10:02:16", "0"));
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1); // never charge twice
    await c.handle(payEv("AAA 1", 2));
    expect(sim.last()).toEqual(["goto", "AAA 1", "leavepark"]); // gateB already Open
    await c.handle(carEv("AAA 1", "EXIT_EXIT", "CarOut", "10:02:18", "0"));
    expect(c.cars.has("AAA 1")).toBe(false);
    const s = c.completed.at(-1)!;
    expect(s).toMatchObject({ payment_ok: true, parked_seconds: 122, entry_lane: "ENTRY1", exit_lane: "EXIT_EXIT" });
    expect(c.counters.revenue).toBe(2);
    expect(c.counters.escaped).toBe(0);
  });

  it("stores finished sessions in the database", async () => {
    const { c, store } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    const rows = store.searchSessions({ plate: "A" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plate: "A", charge_parking: 2, paid: 2, payment_ok: true, spot: "S1" });
  });

  it("admits one car at a time, first in first out", async () => {
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("B", "ENTRY1", "CarIn", "10:00:01"));
    expect(sim.gotos()).toEqual([["goto", "A", "S1"]]); // B waits for A to clear
    await c.handle(carEv("A", "ENTRY1", "CarOut", "10:00:03"));
    expect(sim.gotos().at(-1)).toEqual(["goto", "B", "S2"]);
    expect(sim.calls).not.toContainEqual(["close", "gateA"]); // still busy, gate stays open
  });

  it("turns cars away when the car park is full", async () => {
    const { c, sim } = await make({ sim: FakeSim.lvl1(1) });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("B", "ENTRY1", "CarIn", "10:00:01"));
    expect(sim.calls).toContainEqual(["goto", "B", "leavepark"]);
    expect(c.counters.turned_away).toBe(1);
  });

  it("counts queued cars when deciding if there is room", async () => {
    // 1 free spot, A queued (gate still opening) -> B is turned away, not queued
    const { c, sim } = await make({ sim: FakeSim.lvl1(1) });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("B", "ENTRY1", "CarIn", "10:00:01"));
    expect(sim.calls).toContainEqual(["goto", "B", "leavepark"]);
  });

  it("removes a car that gave up from the queue", async () => {
    const { c } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("B", "ENTRY1", "CarIn", "10:00:01"),
      carEv("B", "ENTRY1", "CarOut", "10:05:01"));
    expect(c.entryLanes.get("ENTRY1")!.queue).not.toContain("B");
    expect(c.counters.neglected).toBe(1);
  });
});
