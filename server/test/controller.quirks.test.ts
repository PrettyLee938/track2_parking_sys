import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
// ---------------------------------------------------------------------------
// simulator quirks
// ---------------------------------------------------------------------------
describe("simulator quirks", () => {
  it("never bills a looping paid car twice", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    expect(sim.charges()).toHaveLength(1);
    // the same car "leaves its spot" and reaches the exit again without ever entering
    await feed(c, carEv("A", "S1", "CarOut", "10:05:00"), carEv("A", "EXIT_EXIT", "CarIn", "10:05:00"));
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1);
    expect(sim.gotos().at(-1)).toEqual(["goto", "A", "leavepark"]);
    expect(c.counters.repeat_exits).toBe(1);
  });

  it("bills a returning customer who comes back through an entry", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"),
      carEv("A", "ENTRY1", "CarIn", "10:10:00"), carEv("A", "ENTRY1", "CarOut", "10:10:02"),
      carEv("A", "S1", "CarIn", "10:10:05"), carEv("A", "S1", "CarOut", "10:11:05"), carEv("A", "EXIT_EXIT", "CarIn", "10:11:10"));
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(2); // a genuine new session
  });

  it("admits a reused plate that still has a stale record (VKW 194)", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c, "VKW 194");
    await fireTimers(c);
    expect(c.cars.get("VKW 194")!.status).toBe("invoiced");
    await c.handle(carEv("VKW 194", "ENTRY1", "CarIn", "11:00:00"));
    expect(["dispatching", "dispatched"]).toContain(c.cars.get("VKW 194")!.status);
    expect(c.cars.get("VKW 194")!.charge_parking).toBeNull(); // a fresh session
    expect(sim.gotos().at(-1)!.slice(0, 2)).toEqual(["goto", "VKW 194"]);
  });

  it("ignores a repeated entry event for a queued car", async () => {
    const { c, sim } = await make();
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarIn", "10:00:01"));
    expect(c.counters.arrived).toBe(1);
    expect(sim.calls).toEqual([["open", "gateA"]]);
  });

  it("resyncs after silence without disturbing a dispatch", async () => {
    const { c, queue } = await make();
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00")); // A is mid-dispatch
    c.lastEventReal! -= c.real(c.cfg.resyncAfterSilenceGameS) + 1;
    await c.handle(gateEv("gateA", "Open"));
    expect(queue.tasks).toHaveLength(1); // resync requested
    await c.sync(); // the live resync
    expect(c.entryLanes.get("ENTRY1")!.current).toBe("A");
    expect(c.spots.get("S1")!.reserved_for).toBe("A");
  });

  it("closes idle open gates on sync, and only gates on a lane", async () => {
    const sim = FakeSim.lvl1(); // gateB starts Open
    const c = new Controller({ sim, cfg: testSettings(), store: new Store(":memory:"), log: silentLog, topologies: [LVL1], queue: new RecordingQueue() });
    await c.sync();
    expect(sim.calls).toContainEqual(["close", "gateB"]);
    expect(sim.calls).not.toContainEqual(["close", "gateC"]); // not on any lane: left alone
  });

  it("re-sends an open the simulator dropped while the gate was closing", async () => {
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarOut", "10:00:02"));
    await fireTimers(c); // -> close gateA
    expect(sim.last()).toEqual(["close", "gateA"]);
    await c.handle(carEv("B", "ENTRY1", "CarIn", "10:00:03")); // arrives while closing
    expect(sim.last()).toEqual(["open", "gateA"]); // the sim will ignore this one
    await c.handle(gateEv("gateA", "Closed"));
    expect(sim.last()).toEqual(["open", "gateA"]);
    expect(sim.calls.filter((x) => x[0] === "open" && x[1] === "gateA")).toHaveLength(2);
    await c.handle(gateEv("gateA", "Open"));
    expect(sim.gotos().at(-1)).toEqual(["goto", "B", "S2"]);
  });

  it("closes gates shortly after the car clears the sensor", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c); // A cleared ENTRY1 -> entry gate close is scheduled
    const entryClose = c.timers.find((t) => t.label === "close gateA")!;
    expect(entryClose.due - Date.now() / 1000).toBeCloseTo(c.real(c.cfg.gateCloseDelayGameS), 1);
    expect(c.cfg.gateCloseDelayGameS).toBe(1.5);
    await fireTimers(c);
    c.gates.get("gateB")!.state = "Closed";
    await c.handle(payEv("A", 2));
    await c.handle(gateEv("gateB", "Open"));
    await c.handle(carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    const exitClose = c.timers.find((t) => t.label === "close gateB")!;
    expect(exitClose.due - Date.now() / 1000).toBeCloseTo(c.real(c.cfg.gateCloseDelayGameS), 1);
    await fireTimers(c);
    expect(sim.last()).toEqual(["close", "gateB"]);
  });

  it("retries an unconfirmed gate, then assumes it is open", async () => {
    const { c, sim } = await make();
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls).toEqual([["open", "gateA"]]);
    const gate = c.gates.get("gateA")!;
    gate.openRequestedAt! -= c.real(c.cfg.gateOpenTimeoutGameS) + 1; // no Open event arrives
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"], ["open", "gateA"]]);
    gate.openRequestedAt! -= c.real(c.cfg.gateOpenTimeoutGameS) + 1;
    await c.tick();
    expect(sim.last()).toEqual(["goto", "A", "S1"]); // lane keeps moving
  });
});
