import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
// ---------------------------------------------------------------------------
// lost webhooks & vanished cars
// ---------------------------------------------------------------------------
describe("lost webhooks", () => {
  const back = (c: Controller, plate: string, field: "releasedReal" | "parkedReal" | "arrivedReal" | "lastSeenReal", gameS: number) => {
    c.cars.get(plate)![field]! -= c.real(gameS) + 1;
  };

  it("keeps both cars when one is parked on top of another; the spot frees when both left", async () => {
    // 16:27 run: JVL 813 and CVF 205 both parked in S12. Keeping one plate per spot made
    // S12 look free when CVF left while JVL was still in it - 83 penalties followed.
    const { c } = await make();
    await feed(c, carEv("JVL 813", "S1", "CarIn", "16:27:29"), carEv("CVF 205", "S1", "CarIn", "16:27:33"));
    await c.handle(carEv("CVF 205", "S1", "CarOut", "16:29:55"));
    expect(c.spots.get("S1")!.available).toBe(false);
    expect(c.spots.get("S1")!.occupant).toBe("JVL 813");
    await c.handle(carEv("JVL 813", "S1", "CarOut", "16:31:00"));
    expect(c.spots.get("S1")!.available).toBe(true);
    expect(c.counters.ghosts_retired).toBe(0);
  });

  it("frees the spot when a car reaches the exit without its spot CarOut", async () => {
    const { c } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarOut", "10:00:02"),
      carEv("A", "S1", "CarIn", "10:00:05"), carEv("A", "EXIT_EXIT", "CarIn", "10:03:10")); // S1 CarOut lost
    expect(c.spots.get("S1")!.occupant).toBeNull();
    await fireTimers(c);
    expect(c.cars.get("A")!.status).toBe("invoiced"); // still billed normally
  });

  it("closes the exit gate when a released car's exit CarOut is lost", async () => {
    const { c, sim } = await make();
    c.gates.get("gateB")!.state = "Closed";
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), gateEv("gateB", "Open")); // released; its exit CarOut never arrives
    expect(c.gateBusy("gateB")).toBe(true);
    await c.tick();
    expect(sim.calls).not.toContainEqual(["close", "gateB"]); // not yet: it may still be driving out
    back(c, "A", "releasedReal", c.cfg.releaseTimeoutGameS);
    await c.tick();
    expect(sim.last()).toEqual(["close", "gateB"]); // the gate does not stay open forever
    expect(c.cars.has("A")).toBe(false);
    expect(c.completed.at(-1)).toMatchObject({ plate: "A", status: "gone", payment_ok: true });
  });

  it("retires a parked car well past its planned stay", async () => {
    const { c } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00", "2"), carEv("A", "ENTRY1", "CarOut", "10:00:02", "2"),
      { ...carEv("A", "S1", "CarIn", "10:00:05", "2"), _received_at: new Date().toISOString() });
    back(c, "A", "parkedReal", 120 + c.cfg.parkedOverstayGameS - 30);
    await c.tick();
    expect(c.cars.get("A")!.status).toBe("parked"); // late, but within the margin
    back(c, "A", "parkedReal", 60);
    await c.tick();
    expect(c.cars.has("A")).toBe(false);
    expect(c.spots.get("S1")!.available).toBe(true);
  });

  it("retires a car silent at the exit for too long, and a queued car past the give-up time", async () => {
    const { c } = await make();
    await parkAndReachExit(c);
    await fireTimers(c); // A invoiced, then nothing more is heard (payment or exit lost)
    await feed(c, carEv("P", "ENTRY1", "CarIn", "10:05:00"), carEv("Q", "ENTRY1", "CarIn", "10:05:01"));
    expect(c.entryLanes.get("ENTRY1")!).toMatchObject({ current: "P", queue: ["Q"] }); // Q waits behind P
    back(c, "A", "lastSeenReal", c.cfg.staleCarGameS);
    back(c, "Q", "arrivedReal", c.cfg.entryPatienceGameS + 60); // Q's "gave up" CarOut was lost
    await c.tick();
    expect(c.cars.has("A")).toBe(false);
    expect(c.cars.has("Q")).toBe(false);
    expect(c.entryLanes.get("ENTRY1")!.queue).toEqual([]);
    expect(c.counters.ghosts_retired).toBe(2);
  });

  it("redirects a car the simulator says was sent to an occupied spot, instead of re-sending it", async () => {
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("ARA 545", "ENTRY1", "CarIn", "16:30:10"));
    expect(sim.last()).toEqual(["goto", "ARA 545", "S1"]);
    await c.handle(penaltyEv("ARA545", "Car:(ARA 545) attempted to park in an occupied spot:(S1)."));
    expect(sim.last()).toEqual(["goto", "ARA 545", "S2"]);
    expect(c.spots.get("S1")!.occupant).toBe("?"); // someone we lost track of is in there
    expect(c.spots.get("S1")!.available).toBe(false);
    c.cars.get("ARA 545")!.dispatchedReal! -= c.real(c.cfg.entryDispatchTimeoutGameS) + 1;
    await c.tick(); // the dispatch retry goes to the new spot, never back to S1
    expect(sim.gotos().filter((g) => g[2] === "S1")).toHaveLength(1);
    await c.handle(carEv("JVL 813", "S1", "CarOut", "16:31:00")); // the unknown car leaves
    expect(c.spots.get("S1")!.available).toBe(true);
  });

  it("releases a car the simulator says has already paid", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(penaltyEv("A", "Car has already paid for parking."));
    expect(sim.last()).toEqual(["goto", "A", "leavepark"]);
    expect(c.cars.get("A")!.status).toBe("released");
  });

  it("ignores the exit sensor while a car drives over it to a spot beyond it (S30)", async () => {
    // PJD 327: exit CarIn/CarOut fired on the way IN to S30; that closed its record, and its
    // real exit later looked like a paid car looping - let out unbilled, an escape penalty.
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("PJD 327", "ENTRY1", "CarIn", "17:23:52"),
      carEv("PJD 327", "ENTRY1", "CarOut", "17:23:52"),
      carEv("PJD 327", "EXIT_EXIT", "CarIn", "17:23:56"), carEv("PJD 327", "EXIT_EXIT", "CarOut", "17:23:56"),
      carEv("PJD 327", "S1", "CarIn", "17:23:56"));
    expect(c.cars.get("PJD 327")!.status).toBe("parked");
    expect(c.counters.escaped).toBe(0);
    await feed(c, carEv("PJD 327", "S1", "CarOut", "17:25:56"), carEv("PJD 327", "EXIT_EXIT", "CarIn", "17:25:57"));
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "PJD 327", 2, 0]]); // billed on the real way out
  });

  it("leaves healthy cars alone", async () => {
    const { c } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    for (let i = 0; i < 5; i++) await c.tick();
    expect(c.cars.get("A")!.status).toBe("invoiced");
    expect(c.counters.ghosts_retired).toBe(0);
  });
});
