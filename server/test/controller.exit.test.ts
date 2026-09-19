import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
// ---------------------------------------------------------------------------
// exit & payment
// ---------------------------------------------------------------------------
describe("exit and payment", () => {
  it("does not release a car that paid the wrong amount", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(payEv("A", 0.5));
    expect(sim.calls).not.toContainEqual(["goto", "A", "leavepark"]);
    expect(c.cars.get("A")!.status).toBe("payment_mismatch");
    expect(c.counters.payment_mismatches).toBe(1);
  });

  it("waits for a closed exit gate to open before releasing", async () => {
    const { c, sim } = await make();
    c.gates.get("gateB")!.state = "Closed";
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(payEv("A", 2));
    expect(sim.last()).toEqual(["open", "gateB"]);
    await c.handle(gateEv("gateB", "Open"));
    expect(sim.last()).toEqual(["goto", "A", "leavepark"]);
  });

  it("retries a charge rejected for timing, then gives up", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c, "QNL 430");
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1);
    for (const attempt of [2, 3]) {
      await c.handle(penaltyEv("QNL430")); // plate without the space
      expect(c.cars.get("QNL 430")!.status).toBe("at_exit");
      await fireTimers(c);
      expect(sim.charges()).toHaveLength(attempt);
    }
    await c.handle(penaltyEv("QNL430"));
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(3); // maxChargeAttempts
    expect(c.counters.penalties).toBe(3);
  });

  it("ignores unrelated penalties", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(penaltyEv("A", "Some other rule"));
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1);
  });

  it("honours billing settings", async () => {
    const { c, sim } = await make({ cfg: { billingRounding: "ceil", pricePerMinute: 2 } });
    await parkAndReachExit(c); // parked exactly 180 s
    await fireTimers(c);
    expect(sim.charges().at(-1)).toEqual(["charge", "A", 6, 0]);
  });

  it("still bills when the exit event arrives before the spot CarOut (S15)", async () => {
    // From S15 (next to the exit) the simulator reports EXIT CarIn ~0.2s BEFORE S15 CarOut.
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("Y", "ENTRY1", "CarIn", "10:00:00"), carEv("Y", "ENTRY1", "CarOut", "10:00:02"),
      carEv("Y", "S1", "CarIn", "10:00:05"), carEv("Y", "EXIT_EXIT", "CarIn", "10:03:05"), carEv("Y", "S1", "CarOut", "10:03:05"));
    expect(c.cars.get("Y")!.status).toBe("at_exit");
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "Y", 2, 0]]);
    await c.handle(payEv("Y", 2));
    expect(sim.gotos().at(-1)).toEqual(["goto", "Y", "leavepark"]);
  });

  it("never sends cars to the exit (they drive there themselves)", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    expect(sim.calls.some((x) => x[0] === "goto" && x[2] === "exit")).toBe(false);
  });

  it("bills planned minutes at any game speed", async () => {
    // Game speed 1.7: a 4-minute planned stay lasts only 2.35 real minutes.
    const { c, sim } = await make();
    const t0 = Date.now() / 1000;
    const stamped = [
      [gateEv("gateA", "Open"), t0], [carEv("V", "ENTRY1", "CarIn", "10:00:00", "4"), t0],
      [carEv("V", "S1", "CarIn", "10:00:05", "4"), t0 + 5], [carEv("V", "S1", "CarOut", "10:02:26", "4"), t0 + 146],
      [carEv("V", "EXIT_EXIT", "CarIn", "10:02:30", "0"), t0 + 150],
    ] as const;
    for (const [ev, ts] of stamped) await c.handle({ ...ev, _received_at: at(ts) });
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "V", 4, 0]]); // right even before the speed is known
    expect(c.timeScaleInfo.source).toBe("default"); // one stay is not enough to learn from
  });

  it("scales measured billing by the learned game speed", async () => {
    const { c, sim } = await make({ cfg: { billingRounding: "round" } });
    const t0 = Date.now() / 1000;
    for (let i = 0; i < 3; i++) { // three stays at game speed 2.0 teach the scale
      await c.handle({ ...carEv(`L${i}`, "S2", "CarIn", "09:00:00", "2"), _received_at: at(t0) });
      await c.handle({ ...carEv(`L${i}`, "S2", "CarOut", "09:01:00", "2"), _received_at: at(t0 + 60) });
    }
    expect(c.timeScale).toBeCloseTo(2, 9);
    await c.handle({ ...carEv("M", "S1", "CarIn", "10:00:00", "0"), _received_at: at(t0) });
    await c.handle({ ...carEv("M", "S1", "CarOut", "10:01:30", "0"), _received_at: at(t0 + 90) });
    await c.handle({ ...carEv("M", "EXIT_EXIT", "CarIn", "10:01:35", "0"), _received_at: at(t0 + 95) });
    await fireTimers(c);
    expect(sim.calls).toContainEqual(["charge", "M", 3, 0]); // 90 real s x 2.0 = 3 game min
  });

  it("re-bills with the amount a wrong-amount penalty states", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c, "VVV 071");
    await fireTimers(c);
    expect(sim.charges().at(-1)).toEqual(["charge", "VVV 071", 2, 0]);
    await c.handle(penaltyEv("VVV071", "Car is being charged wrongly with amount: (2.00). Car type is (Normal) so charge should be: (4.00)"));
    await fireTimers(c);
    expect(sim.charges().at(-1)).toEqual(["charge", "VVV 071", 4, 0]);
    await c.handle(payEv("VVV 071", 4));
    expect(sim.gotos().at(-1)).toEqual(["goto", "VVV 071", "leavepark"]);
  });
});
