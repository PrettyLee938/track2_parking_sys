import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------
describe("recovery", () => {
  const history = () => [
    carEv("Q", "ENTRY1", "CarIn", "10:00:00"), // waiting at entry
    carEv("X", "ENTRY1", "CarIn", "09:59:00"), carEv("X", "ENTRY1", "CarOut", "09:59:02"),
    carEv("X", "S2", "CarIn", "09:59:05"), carEv("X", "S2", "CarOut", "10:01:05"),
    carEv("X", "EXIT_EXIT", "CarIn", "10:01:10"), // stuck at exit, unbilled
    carEv("P", "ENTRY1", "CarIn", "09:58:00"), carEv("P", "ENTRY1", "CarOut", "09:58:02"),
    carEv("P", "S1", "CarIn", "09:58:05"), // parked
  ];

  function controllerWithLog(receivedAt: string, events = history(), detectedAt = ["ENTRY1", "EXIT_EXIT", "S1"]) {
    const store = new Store(":memory:");
    for (const e of events) store.recordEvent({ ...e, _received_at: receivedAt, _accepted: true });
    const sim = FakeSim.lvl1();
    for (const s of sim.spots) s.detectedCars = detectedAt.includes(s.name) ? 1 : 0;
    const c = new Controller({ sim, cfg: testSettings(), store, log: silentLog, topologies: [LVL1], queue: new RecordingQueue() });
    return { c, sim, events };
  }

  it("rebuilds queue, parked cars and unbilled exits from the log", async () => {
    const { c, sim, events } = controllerWithLog(new Date().toISOString());
    await c.sync({ replay: true });
    const lane = c.entryLanes.get("ENTRY1")!;
    expect(c.cars.get("P")!.status).toBe("parked");
    expect(c.spots.get("S1")!.occupant).toBe("P");
    expect(c.spots.get("S2")!.occupant).toBeNull(); // X left it
    expect(lane.queue).toEqual([]);
    expect(lane.current).toBe("Q"); // Q dispatched after recovery
    expect(sim.calls[0]).toEqual(["open", "gateA"]); // no replayed commands re-sent
    await fireTimers(c);
    expect(sim.calls).toContainEqual(["charge", "X", 2, 0]); // X finally billed
    await c.handle(events[0]); // also in the live queue...
    expect(lane.queue).toEqual([]); // ...but processed once
  });

  it("keeps a car that was mid-way in across a restart, so its spot is not given away (JVL 813)", async () => {
    // 16:27: server restarted (tsx watch) 2 s after sending JVL 813 to S12. Startup dropped it
    // and freed S12, so CVF 205 was sent there too.
    const store = new Store(":memory:");
    const now = new Date().toISOString();
    store.recordEvent({ ...carEv("JVL 813", "ENTRY1", "CarIn", "16:27:22"), _received_at: now, _accepted: true });
    store.recordAction({ at: now, cmd: "goto", args: ["JVL 813", "S1"], ok: true, error: null, ms: 2 });
    const sim = FakeSim.lvl1();
    for (const s of sim.spots) s.detectedCars = s.name === "ENTRY1" ? 1 : 0;
    const c = new Controller({ sim, cfg: testSettings({ closeIdleGatesOnSync: false }), store, log: silentLog, topologies: [LVL1], queue: new RecordingQueue() });
    await c.sync({ replay: true });
    expect(c.spots.get("S1")!.reserved_for).toBe("JVL 813");
    expect(c.entryLanes.get("ENTRY1")!.current).toBe("JVL 813");
    expect(sim.calls).toEqual([]); // nothing re-decided, nothing re-sent
    // its entry CarOut was lost during the restart; CVF 205 arrives and parks in S1? No - S2.
    await feed(c, gateEv("gateA", "Open"), carEv("JVL 813", "S1", "CarIn", "16:27:29"), carEv("CVF 205", "ENTRY1", "CarIn", "16:27:26"));
    expect(sim.last()).toEqual(["goto", "CVF 205", "S2"]);
  });

  it("remembers charges across a restart, so a paid car is not billed again", async () => {
    // 17:19-17:22: after each restart, cars that had been charged and had paid were charged
    // again - replay only knew the events, not our charge commands.
    const store = new Store(":memory:");
    let t = Date.now() - 30_000;
    const next = () => new Date((t += 1000)).toISOString(); // events and commands interleave in time
    const rec = (e: ReturnType<typeof carEv>) => store.recordEvent({ ...e, _received_at: next(), _accepted: true });
    const cmd = (...args: string[]) => store.recordAction({ at: next(), cmd: args[0], args: args.slice(1), ok: true, error: null, ms: 2 });
    rec(carEv("CTV 274", "ENTRY1", "CarIn", "17:19:16"));
    cmd("goto", "CTV 274", "S2");
    rec(carEv("CTV 274", "ENTRY1", "CarOut", "17:19:20"));
    rec(carEv("CTV 274", "S2", "CarIn", "17:19:22"));
    rec(carEv("CTV 274", "S2", "CarOut", "17:19:30"));
    rec(carEv("CTV 274", "EXIT_EXIT", "CarIn", "17:19:32"));
    cmd("charge", "CTV 274", "1", "0");
    store.recordEvent({ ...payEv("CTV 274", 1), _received_at: next(), _accepted: true });
    cmd("goto", "CTV 274", "leavepark");
    const sim = FakeSim.lvl1();
    for (const s of sim.spots) s.detectedCars = s.name === "EXIT_EXIT" ? 1 : 0;
    const c = new Controller({ sim, cfg: testSettings({ closeIdleGatesOnSync: false }), store, log: silentLog, topologies: [LVL1], queue: new RecordingQueue() });
    await c.sync({ replay: true });
    await fireTimers(c);
    expect(sim.charges()).toEqual([]);
    expect(c.cars.get("CTV 274")).toMatchObject({ status: "released", charge_parking: 1, paid: 1, payment_ok: true });
    expect(c.counters.admitted).toBe(1);
  });

  it("does not replay a stale log (simulator likely restarted)", async () => {
    const old = new Date(Date.now() - 25 * 60_000).toISOString();
    const { c, sim } = controllerWithLog(old, [carEv("P", "ENTRY1", "CarIn", "09:58:00"), carEv("P", "S1", "CarIn", "09:58:05"),
      carEv("X", "EXIT_EXIT", "CarIn", "10:01:10")], ["EXIT_EXIT", "S1"]);
    await c.sync({ replay: true });
    await fireTimers(c);
    expect(c.cars.size).toBe(0);
    expect(sim.charges()).toEqual([]);
  });
});
