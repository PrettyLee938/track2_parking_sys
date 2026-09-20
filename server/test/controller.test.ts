/** Controller logic against a fake simulator (no network). Port of the Python suite. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAllocator } from "../src/allocation";
import { loadSettings, REPO_ROOT, unknownSettingVars } from "../src/config";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { loadDir, resolve, type Topology } from "../src/topology";
import {
  at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue,
  silentLog, testSettings, TWO_ZONES, twoZoneSim,
} from "./helpers";

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

  it("gives one exit lane to one paid car at a time and waits for gate clearance", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c, "A");
    await c.handle(carEv("B", "EXIT_EXIT", "CarIn", "10:03:11"));
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ queue: ["A", "B"], passage_owner: "A", passage_state: "waiting_payment" });
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "A", 2, 0]]); // B has no invoice while A owns the lane

    await c.handle(payEv("B", 2)); // no B invoice exists; this cannot borrow A's open gate
    expect(sim.gotos()).not.toContainEqual(["goto", "B", "leavepark"]);
    await c.handle(payEv("A", 2));
    expect(sim.gotos()).toContainEqual(["goto", "A", "leavepark"]);
    await c.handle(carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    await fireTimers(c); // clearance delay elapsed; close is sent but not yet confirmed
    expect(sim.last()).toEqual(["close", "gateB"]);
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ passage_owner: "A", passage_state: "closing" });
    expect(sim.charges()).toHaveLength(1);

    await c.handle(gateEv("gateB", "Closed"));
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ passage_owner: "B", passage_state: "uncertain" });
    await fireTimers(c);
    expect(sim.charges()).toHaveLength(1); // no guessed charge for a visit without an entry/parking record
    expect((await c.reviewUnknownDuration("B", c.cars.get("B")!.state_version ?? 0, 2, "verified entry record in lane log", "operator")).ok).toBe(true);
    await fireTimers(c);
    expect(sim.charges()[1]).toEqual(["charge", "B", 2, 0]);
    await c.handle(payEv("B", 2));
    expect(sim.calls).toContainEqual(["open", "gateB"]);
    await c.handle(gateEv("gateB", "Open"));
    expect(sim.gotos()).toContainEqual(["goto", "B", "leavepark"]);
  });

  it("marks a shared-open tailgate as uncertain and does not advance the next passage", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c, "A");
    await c.handle(carEv("B", "EXIT_EXIT", "CarIn", "10:03:11"));
    await fireTimers(c);
    await c.handle(payEv("A", 2));
    await c.handle(gateEv("gateB", "Open"));
    await c.handle(carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    await c.handle(carEv("B", "EXIT_EXIT", "CarOut", "10:03:13")); // uncharged follower crosses before close
    await fireTimers(c);
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ passage_owner: "A", passage_state: "uncertain" });
    expect(c.counters.escaped).toBe(1);
    expect(sim.calls.filter((call) => call[0] === "close" && call[1] === "gateB")).toHaveLength(0);
    expect(c.feed.some((f) => f.msg.includes("possible tailgate"))).toBe(true);
  });

  it("records a zero-value admin waiver separately from simulator revenue", async () => {
    const { c, sim, store } = await make();
    await c.handle(carEv("UNKNOWN", "EXIT_EXIT", "CarIn", "10:00:00"));
    const car = c.cars.get("UNKNOWN")!;
    const result = await c.adminWaiveVisit(car.visit_id!, "waiver-request-001", car.state_version ?? 0,
      "validated camera evidence confirms a short stay", "admin");
    expect(result.ok).toBe(true);
    expect(sim.calls).toContainEqual(["goto", "UNKNOWN", "leavepark"]);
    expect(store.listFinancialAdjustments(car.visit_id)).toMatchObject([{ kind: "waiver", amount_minor: 0, actor: "admin" }]);
    expect(store.latestInvoice(car.visit_id!)?.status).toBe("waived");
    expect(c.counters.revenue).toBe(0);
    const before = sim.gotos().length;
    expect((await c.adminWaiveVisit(car.visit_id!, "waiver-request-001", car.state_version ?? 0,
      "validated camera evidence confirms a short stay", "admin")).ok).toBe(true);
    expect(sim.gotos()).toHaveLength(before); // request ID makes retries idempotent
  });

  it("audits an admin emergency release without claiming payment", async () => {
    const { c, sim, store } = await make();
    await c.handle(carEv("EMERGENCY", "EXIT_EXIT", "CarIn", "10:00:00"));
    const car = c.cars.get("EMERGENCY")!;
    const result = await c.adminEmergencyRelease(car.visit_id!, "emergency-request-001", car.state_version ?? 0,
      "medical emergency verified by the duty supervisor", "admin");
    expect(result.ok).toBe(true);
    expect(sim.calls).toContainEqual(["goto", "EMERGENCY", "leavepark"]);
    expect(car.payment_ok).toBeNull();
    expect(store.listFinancialAdjustments(car.visit_id)).toMatchObject([{ kind: "emergency_release", amount_minor: 0 }]);
    expect(store.listIncidents().some((incident) => incident.type === "admin_emergency_release")).toBe(true);
  });

  it("records signed accounting adjustments without changing simulator settlement", async () => {
    const { c, store } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    const session = store.searchSessions({ plate: "A" })[0];
    const revenueBefore = c.counters.revenue;
    expect(c.adminApplyFinancialAdjustment(session.visit_id!, "adjustment-request-001", session.state_version ?? 0,
      -0.5, "goodwill credit approved by finance", "admin").ok).toBe(true);
    expect(store.listFinancialAdjustments(session.visit_id)).toMatchObject([{ kind: "adjustment", amount_minor: -50 }]);
    expect(c.counters.revenue).toBe(revenueBefore);
  });

  it("retries a missing close confirmation once, then requires audited clearance", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(payEv("A", 2));
    await c.handle(gateEv("gateB", "Open"));
    await c.handle(carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    await fireTimers(c); // close request sent
    const gate = c.gates.get("gateB")!;
    gate.closeRequestedAt = c.clock.now() - c.cfg.gateConfirmGameS - 1;
    await c.tick();
    expect(sim.calls.filter((call) => call[0] === "close" && call[1] === "gateB")).toHaveLength(2);
    gate.closeRequestedAt = c.clock.now() - c.cfg.gateConfirmGameS - 1;
    await c.tick();
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ passage_owner: "A", passage_state: "uncertain" });
    expect((await c.confirmExitClearance("EXIT_EXIT", "verified exit lane is clear", "oper")).ok).toBe(true);
    expect(sim.calls.filter((call) => call[0] === "close" && call[1] === "gateB")).toHaveLength(3);
  });

  it("refuses a manual gate-open while an exit passage is queued", async () => {
    const { c, sim } = await make();
    await parkAndReachExit(c, "A");
    const result = await c.manualGate("gateB", "open", "oper");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/payment\/passage queue/);
    expect(sim.calls).not.toContainEqual(["open", "gateB"]);
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
    const { c, sim, advance } = await make({ cfg: { billingRounding: "ceil", pricePerMinute: 2, gameSpeed: 1 } });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarOut", "10:00:02"),
      carEv("A", "S1", "CarIn", "10:00:05"));
    advance(179.5); // parked 179.5 s -> ceil 3 minutes
    await feed(c, carEv("A", "S1", "CarOut", "10:03:05"), carEv("A", "EXIT_EXIT", "CarIn", "10:03:10"));
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
    const { c, sim, advance } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("V", "ENTRY1", "CarIn", "10:00:00", "4"));
    advance(5);
    await c.handle(carEv("V", "S1", "CarIn", "10:00:05", "4"));
    advance(141);
    await c.handle(carEv("V", "S1", "CarOut", "10:02:26", "4"));
    advance(4);
    await c.handle(carEv("V", "EXIT_EXIT", "CarIn", "10:02:30", "0"));
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "V", 4, 0]]); // right even before the speed is known
    expect(c.timeScaleInfo.source).toBe("default"); // one stay is not enough to learn from
  });

  it("scales measured billing by the learned game speed", async () => {
    const { c, sim, advance } = await make({ cfg: { billingRounding: "round" } });
    for (let i = 0; i < 3; i++) { // three stays at game speed 2.0 teach the scale
      await c.handle(carEv(`L${i}`, "S2", "CarIn", "09:00:00", "2"));
      advance(60);
      await c.handle(carEv(`L${i}`, "S2", "CarOut", "09:01:00", "2"));
    }
    expect(c.timeScale).toBeCloseTo(2, 9);
    await c.handle(carEv("M", "S1", "CarIn", "10:00:00", "0"));
    advance(90);
    await c.handle(carEv("M", "S1", "CarOut", "10:01:30", "0"));
    advance(5);
    await c.handle(carEv("M", "EXIT_EXIT", "CarIn", "10:01:35", "0"));
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

// ---------------------------------------------------------------------------
// game speed
// ---------------------------------------------------------------------------
describe("game speed", () => {
  const simSettings = (speed: number) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "gpa-sim-")), "settings.json");
    writeFileSync(file, "\uFEFF" + JSON.stringify({ TeamName: "T", GameSpeedMultiplier: speed })); // the sim writes a BOM
    return file;
  };
  /** Real seconds until a timer fires, at the current speed. */
  const dueIn = (c: Controller, label: string) => c.clock.realUntil(c.timers.find((t) => t.label === label)!.due);

  /** Three completed stays at the given game speed (planned 2 game-min each). */
  async function learnSpeed(c: Controller, advance: (s: number) => void, speed: number, spot = "S3") {
    for (let i = 0; i < 3; i++) {
      await c.handle(carEv(`L${speed}${i}`, spot, "CarIn", "09:00:00", "2"));
      advance(120 / speed);
      await c.handle(carEv(`L${speed}${i}`, spot, "CarOut", "09:02:00", "2"));
    }
  }

  /** n automatic gate cycles on gateA, each move taking moveRealS. */
  async function gateCycles(c: Controller, advance: (s: number) => void, n: number, moveRealS: number) {
    for (let i = 0; i < n; i++) {
      await c.handle(carEv(`G${moveRealS}${i}`, "ENTRY1", "CarIn", "10:00:00")); // -> open gateA
      advance(moveRealS);
      await c.handle(gateEv("gateA", "Open"));
      await c.handle(carEv(`G${moveRealS}${i}`, "ENTRY1", "CarOut", "10:00:01"));
      await fireTimers(c); // -> close gateA
      advance(moveRealS);
      await c.handle(gateEv("gateA", "Closed"));
      await c.handle(carEv(`G${moveRealS}${i}`, "S1", "CarIn", "10:00:03"));
      await c.handle(carEv(`G${moveRealS}${i}`, "S1", "CarOut", "10:00:04"));
    }
  }

  it("scales simulator timers by the game speed", async () => {
    for (const speed of [0.5, 1, 2, 4]) {
      const { c } = await make({ cfg: { gameSpeed: speed } });
      await parkAndReachExit(c);
      expect(dueIn(c, "close gateA")).toBeCloseTo(c.cfg.gateCloseDelayGameS / speed, 1);
      expect(dueIn(c, "charge A")).toBeCloseTo(c.cfg.exitChargeDelayGameS / speed, 1);
    }
  });

  it("scales the gate-confirmation timeout by the game speed", async () => {
    const { c, sim, advance } = await make({ cfg: { gameSpeed: 0.5 } }); // slow game: 3 game-s = 6 real s
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    advance(4); // too early to retry at half speed
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"]]);
    advance(3);
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"], ["open", "gateA"]]);
  });

  it("takes the speed from, in order: configuration, learned stays, simulator settings, 1.0", async () => {
    expect((await make()).c.timeScaleInfo).toEqual({ value: 1, source: "default" });

    const { c, advance } = await make({ cfg: { simSettingsFile: simSettings(1.7) } });
    expect(c.timeScaleInfo).toEqual({ value: 1.7, source: "simulator settings" });
    await learnSpeed(c, advance, 2);
    expect(c.timeScaleInfo.source).toBe("learned");
    expect(c.timeScale).toBeCloseTo(2, 6);

    const fixed = await make({ cfg: { gameSpeed: 3, simSettingsFile: simSettings(1.7) } });
    await learnSpeed(fixed.c, fixed.advance, 2);
    expect(fixed.c.timeScaleInfo).toEqual({ value: 3, source: "configured" });
  });

  it("follows a speed change within a few gate cycles, before any stay completes", async () => {
    // 21:10 run: speed raised 1.7 -> 3.3 while running. Stays took minutes to catch up, and
    // until then every timer ran at the old speed.
    const { c, advance } = await make();
    await learnSpeed(c, advance, 2);
    // A move takes 0.03 s (network) + 0.5 game-s: 0.28 s at speed 2 calibrates...
    await gateCycles(c, advance, 5, 0.28);
    expect(c.timeScaleInfo).toMatchObject({ source: "learned" });
    await gateCycles(c, advance, 3, 0.155); // ...and 0.155 s means speed 4
    expect(c.timeScaleInfo.source).toBe("gate timing");
    expect(c.timeScale).toBeCloseTo(4, 1);
    await learnSpeed(c, advance, 4, "S2"); // stays measured at the new speed take over again
    expect(c.timeScaleInfo.source).toBe("learned");
    expect(c.timeScale).toBeCloseTo(4, 6);
  });

  it("stops the game clock while the game is paused, so parked cars do not look overdue", async () => {
    // 20:35-21:07 the game sat paused for 31 minutes; on real time every parked car looked
    // long overdue and was retired, freeing spots that were still taken.
    const { c, advance } = await make({ cfg: { gameSpeed: 1 } });
    await c.handle(carEv("P", "S1", "CarIn", "20:35:00", "2"));
    advance(60);
    advance(1860, false); // paused: no events at all
    await c.tick();
    expect(c.cars.get("P")!.status).toBe("parked");
    expect(c.spots.get("S1")!.available).toBe(false);
    advance(c.cfg.parkedOverstayGameS + 120); // running again: now it really is overdue
    await c.tick();
    expect(c.cars.has("P")).toBe(false);
  });

  it("relearns when the simulator is restarted at another speed", async () => {
    const file = simSettings(1.7);
    const { c, advance } = await make({ cfg: { simSettingsFile: file } });
    await learnSpeed(c, advance, 1.7);
    expect(c.timeScaleInfo.source).toBe("learned");
    writeFileSync(file, JSON.stringify({ GameSpeedMultiplier: 3 })); // restarted with a new speed
    await c.sync();
    expect(c.timeScaleInfo).toEqual({ value: 3, source: "simulator settings" });
  });

  it("flags GPA_ variables that match no setting (e.g. names from before the rename)", () => {
    expect(unknownSettingVars({ GPA_GATE_CLOSE_DELAY_S: "3", GPA_GATE_CLOSE_DELAY_GAME_S: "1.5", PATH: "x" }))
      .toEqual(["GPA_GATE_CLOSE_DELAY_S"]);
  });

  it("finds settings.json next to the level files", () => {
    const expected = path.join(path.resolve("C:/sim/settings"), "settings.json");
    expect(loadSettings({ GPA_SIM_LEVELS_DIR: "C:/sim/settings" }).simSettingsFile).toBe(expected);
    expect(testSettings({ simLevelsDir: path.resolve("C:/sim/settings") }).simSettingsFile).toBe(expected);
    expect(loadSettings({ GPA_SIM_LEVELS_DIR: "C:/sim/settings", GPA_SIM_SETTINGS_FILE: "C:/other.json" }).simSettingsFile)
      .toBe(path.resolve("C:/other.json")); // an explicit file wins
  });
});

// ---------------------------------------------------------------------------
// multi-lane sites & topology
// ---------------------------------------------------------------------------
describe("multi-lane sites", () => {
  it("gives each entry its own gate, queue and zone", async () => {
    const { c, sim } = await make({ sim: twoZoneSim(), topo: TWO_ZONES });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("B", "ENTRY2", "CarIn", "10:00:00"));
    expect(sim.calls).toContainEqual(["open", "g1"]);
    expect(sim.calls).toContainEqual(["open", "g3"]);
    await feed(c, gateEv("g1", "Open"), gateEv("g3", "Open"));
    expect(sim.calls).toContainEqual(["goto", "A", "S1"]); // ZONE1 spot for the ZONE1 lane
    expect(sim.calls).toContainEqual(["goto", "B", "S3"]); // ZONE2 spot, never the Electric one
  });

  it("sends electric cars to charger spots first", async () => {
    const { c, sim } = await make({ sim: twoZoneSim(), topo: TWO_ZONES });
    await feed(c, gateEv("g3", "Open"), carEv("E", "ENTRY2", "CarIn", "10:00:00", "2", "Electric"));
    expect(sim.calls).toContainEqual(["goto", "E", "S4"]);
  });

  it("opens the gate of the exit the car reached", async () => {
    const { c, sim } = await make({ sim: twoZoneSim(), topo: TWO_ZONES });
    c.gates.get("g4")!.state = "Closed";
    await feed(c, gateEv("g3", "Open"), carEv("B", "ENTRY2", "CarIn", "10:00:00"), carEv("B", "S3", "CarIn", "10:00:05"),
      carEv("B", "S3", "CarOut", "10:01:05"), carEv("B", "Exit67", "CarIn", "10:01:10"));
    await fireTimers(c);
    await c.handle(payEv("B", 2));
    expect(sim.last()).toEqual(["open", "g4"]);
  });

  it("turns cars away when their zone is full even if another has room", async () => {
    const { c, sim } = await make({ sim: twoZoneSim(), topo: TWO_ZONES });
    await c.handle(gateEv("g1", "Open"));
    for (const [i, p] of ["A", "B", "C"].entries()) await c.handle(carEv(p, "ENTRY1", "CarIn", `10:00:0${i}`));
    expect(sim.calls).toContainEqual(["goto", "C", "leavepark"]); // ZONE1 has only 2 spots
  });

  it("crosses zones with the any-zone strategy", async () => {
    const { c, sim } = await make({ sim: twoZoneSim(), topo: TWO_ZONES, cfg: { allocationStrategy: "any_zone_first_free" } });
    await c.handle(gateEv("g1", "Open"));
    for (const [i, p] of ["A", "B", "C"].entries()) {
      await feed(c, carEv(p, "ENTRY1", "CarIn", `10:00:0${i}`), carEv(p, "ENTRY1", "CarOut", `10:00:1${i}`));
    }
    expect(sim.calls).toContainEqual(["goto", "C", "S3"]);
  });

  it("reloads the layout on an unknown entry and handles that same car (level switch)", async () => {
    const { c, sim } = await make({ topologies: [LVL1, TWO_ZONES] });
    const next = twoZoneSim(); // the simulator switched to a two-zone level
    sim.spots = next.spots;
    sim.barriers = next.barriers;
    await c.handle(carEv("Z", "ENTRY2", "CarIn", "10:00:00"));
    expect(c.topology!.name).toBe("test-2zones");
    expect([...c.entryLanes.keys()].sort()).toEqual(["ENTRY1", "ENTRY2"]);
    expect(sim.last()).toEqual(["open", "g3"]); // Z is being admitted, not dropped
    expect(c.entryLanes.get("ENTRY2")!.current).toBe("Z");
  });

  it("admits the first car when the level loads after the server started", async () => {
    // Server synced while the simulator was still on its menu: no spots at all.
    const sim = new FakeSim([], []);
    const { c } = await make({ sim });
    expect(c.topology).toBeNull();
    const level = FakeSim.lvl1();
    sim.spots = level.spots;
    sim.barriers = level.barriers;
    await c.handle(carEv("RFB 098", "ENTRY1", "CarIn", "10:00:00")); // the level's first car
    expect(c.topology!.name).toBe("test-lvl1");
    expect(sim.calls).toEqual([["open", "gateA"]]);
    await c.handle(gateEv("gateA", "Open"));
    expect(sim.last()).toEqual(["goto", "RFB 098", "S1"]);
  });

  it("ignores events from a spot that is not in the layout, without reloading every time", async () => {
    const { c, sim } = await make();
    const atEntry9 = (plate: string) => ({ ...carEv(plate, "ENTRY9", "CarIn", "10:00:00"), SpotType: "EntrySpot" });
    await c.handle(atEntry9("Z"));
    await c.handle(atEntry9("Y"));
    expect(c.cars.has("Z") || c.cars.has("Y")).toBe(false);
    expect(sim.calls).toEqual([]);
    expect(c.feed.filter((f) => f.msg.includes("reloading layout now"))).toHaveLength(1);
  });
});

describe("topology", () => {
  const empty = path.join(REPO_ROOT, "does-not-exist");

  it("picks the matching topology and rejects ones naming missing gates", () => {
    const sim = FakeSim.lvl1();
    const wrong: Topology = { name: "wrong", entry_lanes: [{ spot: "ENTRY1", gate: "nope", zone: "" }], exit_lanes: [{ spot: "EXIT_EXIT", gate: "gateB", zone: "" }] };
    const t = resolve(sim.spots, sim.barriers, { topologyDir: empty, maxGateDistance: 400, candidates: [TWO_ZONES, wrong, LVL1] });
    expect(t.name).toBe("test-lvl1");
  });

  it("falls back to gate-less lanes when nothing matches", () => {
    const sim = FakeSim.lvl1();
    const t = resolve(sim.spots, sim.barriers, { topologyDir: empty, maxGateDistance: 400 });
    expect(t.source).toBe("fallback");
    expect(t.entry_lanes[0].gate).toBeNull();
  });

  it("has valid committed topology files", () => {
    const all = loadDir(path.join(REPO_ROOT, "topology"));
    expect(all.map((t) => t.name).sort()).toEqual(["lvl1", "lvl2", "lvl3"]);
    for (const t of all) {
      expect(t.entry_lanes.length && t.exit_lanes.length).toBeTruthy();
      const gates = [...t.entry_lanes, ...t.exit_lanes].map((l) => l.gate).filter(Boolean);
      expect(new Set(gates).size, `${t.name}: a gate serves two lanes`).toBe(gates.length);
    }
  });

  it("rejects an unknown allocation strategy", () => {
    expect(() => getAllocator("nope")).toThrow(/lane_zone_first_free/);
  });
});

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

  it("re-arms the exit-gate clearance delay after a restart during the clearing phase", async () => {
    const store = new Store(":memory:");
    let t = Date.now() - 20_000;
    const next = () => new Date((t += 1000)).toISOString();
    const event = (value: ReturnType<typeof carEv>) => store.recordEvent({ ...value, _received_at: next(), _accepted: true });
    const action = (cmd: string, ...args: string[]) => store.recordAction({ at: next(), cmd, args, ok: true, error: null, ms: 2 });
    event(carEv("CLEARING", "ENTRY1", "CarIn", "10:00:00"));
    action("goto", "CLEARING", "S1");
    event(carEv("CLEARING", "ENTRY1", "CarOut", "10:00:02"));
    event(carEv("CLEARING", "S1", "CarIn", "10:00:05"));
    event(carEv("CLEARING", "S1", "CarOut", "10:02:05"));
    event(carEv("CLEARING", "EXIT_EXIT", "CarIn", "10:02:10"));
    action("charge", "CLEARING", "1", "0");
    store.recordEvent({ ...payEv("CLEARING", 1), _received_at: next(), _accepted: true });
    action("goto", "CLEARING", "leavepark");
    store.recordEvent({ ...gateEv("gateB", "Open"), _received_at: next(), _accepted: true });
    event(carEv("CLEARING", "EXIT_EXIT", "CarOut", "10:02:12"));

    const sim = FakeSim.lvl1();
    sim.barriers.find((barrier) => barrier.name === "gateB")!.state = "Open";
    const c = new Controller({ sim, cfg: testSettings({ closeIdleGatesOnSync: false }), store, log: silentLog,
      topologies: [LVL1], queue: new RecordingQueue() });
    await c.sync({ replay: true });

    const lane = c.exitLanes.get("EXIT_EXIT")!;
    expect(lane).toMatchObject({ passageOwner: "CLEARING", passageState: "clearing", clearanceCloseScheduled: true });
    expect(c.timers.filter((timer) => timer.label === "close gateB")).toHaveLength(1);
    await fireTimers(c);
    expect(sim.calls).toContainEqual(["close", "gateB"]);
    expect(lane.passageState).toBe("closing");
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
    await feed(c, payEv("A", 2), carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    await fireTimers(c);
    await c.handle(gateEv("gateB", "Closed")); // a new passage waits for the prior barrier cycle to finish
    await feed(c,
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
    expect(entryClose.due - c.clock.now()).toBeCloseTo(c.cfg.gateCloseDelayGameS, 1);
    expect(c.cfg.gateCloseDelayGameS).toBe(1.5);
    await fireTimers(c);
    c.gates.get("gateB")!.state = "Closed";
    await c.handle(payEv("A", 2));
    await c.handle(gateEv("gateB", "Open"));
    await c.handle(carEv("A", "EXIT_EXIT", "CarOut", "10:03:12"));
    const exitClose = c.timers.find((t) => t.label === "close gateB")!;
    expect(exitClose.due - c.clock.now()).toBeCloseTo(c.cfg.gateCloseDelayGameS, 1);
    await fireTimers(c);
    expect(sim.last()).toEqual(["close", "gateB"]);
  });

  it("retries an unconfirmed gate, then assumes it is open", async () => {
    const { c, sim } = await make();
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls).toEqual([["open", "gateA"]]);
    const gate = c.gates.get("gateA")!;
    gate.openRequestedAt! -= c.cfg.gateConfirmGameS + 1; // no Open event arrives
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"], ["open", "gateA"]]);
    gate.openRequestedAt! -= c.cfg.gateConfirmGameS + 1;
    await c.tick();
    expect(sim.last()).toEqual(["goto", "A", "S1"]); // lane keeps moving
  });

  it("re-sends a close the simulator never confirmed", async () => {
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarOut", "10:00:02"));
    await fireTimers(c);
    expect(sim.last()).toEqual(["close", "gateA"]);
    c.gates.get("gateA")!.closeRequestedAt! -= c.cfg.gateConfirmGameS + 1; // no Closed event arrives
    await c.tick();
    expect(sim.calls.filter((x) => x[0] === "close" && x[1] === "gateA")).toHaveLength(2);
    await c.tick(); // only once
    expect(sim.calls.filter((x) => x[0] === "close" && x[1] === "gateA")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// commands the simulator dropped
// ---------------------------------------------------------------------------
describe("dropped gotos", () => {
  /** Let game time pass without the car moving. */
  const wait = (advance: (s: number) => void, c: Controller, gameS: number) => advance(gameS / c.timeScale);

  it("re-sends a goto the car at the entry never acted on, keeping the rest of the queue waiting", async () => {
    // 21:10:58 run: KAB 813's goto S21 was dropped; it sat on ENTRY1 for 10 s with gateA
    // open, the four cars behind it piled up, then all went in at once.
    const { c, sim, advance } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("KAB 813", "ENTRY1", "CarIn", "21:10:58"), carEv("AAA 509", "ENTRY1", "CarIn", "21:11:00"));
    expect(sim.gotos()).toEqual([["goto", "KAB 813", "S1"]]);
    wait(advance, c, c.cfg.gotoConfirmGameS - 1);
    await c.tick();
    expect(sim.gotos()).toHaveLength(1); // normal cars take ~2 game-s
    wait(advance, c, 2);
    await c.tick();
    expect(sim.gotos()).toEqual([["goto", "KAB 813", "S1"], ["goto", "KAB 813", "S1"]]);
    expect(c.counters.admitted).toBe(1); // a re-send is not a new admission
    await c.handle(carEv("KAB 813", "ENTRY1", "CarOut", "21:11:01"));
    expect(sim.gotos().at(-1)).toEqual(["goto", "AAA 509", "S2"]);
  });

  it("gives up on a car that never leaves the entry after the re-sends, so the lane moves", async () => {
    const { c, sim, advance } = await make({ cfg: { maxGotoResends: 2 } });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("B", "ENTRY1", "CarIn", "10:00:02"));
    for (let i = 0; i < 3; i++) {
      wait(advance, c, c.cfg.gotoConfirmGameS + 0.5);
      await c.tick();
    }
    expect(sim.gotos().filter((g) => g[1] === "A")).toHaveLength(3);
    expect(sim.gotos().at(-1)).toEqual(["goto", "B", "S1"]); // A's spot went to B
  });

  it("quarantines a Level 2 reservation when a dispatched car stops responding", async () => {
    const { c, sim, advance, store } = await make({ cfg: { webhookProfile: "level2", maxGotoResends: 0, staleCarGameS: 1 } });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"),
      carEv("B", "ENTRY1", "CarIn", "10:00:02"));
    expect(c.spots.get("S1")!.reserved_for).toBe("A");
    wait(advance, c, c.cfg.gotoConfirmGameS + 1);
    await c.tick();

    expect(c.cars.get("A")!.status).toBe("unknown");
    expect(c.spots.get("S1")!.reserved_for).toBe("A");
    expect(sim.gotos()).toContainEqual(["goto", "B", "S2"]);
    expect(store.getIncidentByCorrelation("uncertain_reservation", c.cars.get("A")!.visit_id!)?.status).toBe("open");

    wait(advance, c, 5);
    await c.tick();
    expect(c.cars.get("A")!.status).toBe("unknown");
    expect(c.spots.get("S1")!.reserved_for).toBe("A");
  });

  it("releases a queued car's place without reserving a spot when it abandons before dispatch", async () => {
    const { c, sim } = await make({ cfg: { webhookProfile: "level2" } });
    await feed(c, gateEv("gateA", "Open"),
      carEv("A", "ENTRY1", "CarIn", "10:00:00"), // dispatched and owns S1
      carEv("B", "ENTRY1", "CarIn", "10:00:01"), // queued; no parking spot assigned yet
      carEv("B", "ENTRY1", "CarOut", "10:00:02")); // leaves while still queued

    expect(c.entryLanes.get("ENTRY1")!.queue).toEqual([]);
    expect(c.entryLanes.get("ENTRY1")!.current).toBe("A");
    expect(c.cars.has("B")).toBe(false); // completed/removed from active records
    expect([...c.spots.values()].some((spot) => spot.reserved_for === "B")).toBe(false);
    expect(sim.gotos().some(([, plate]) => plate === "B")).toBe(false);
    expect(c.completed.at(-1)).toMatchObject({ plate: "B", status: "neglected", spot: null });
  });

  it("holds a car with no trusted parking history instead of falling back to a one-minute charge", async () => {
    const { c, sim, store } = await make();
    await c.handle(carEv("UNKNOWN 1", "EXIT_EXIT", "CarIn", "10:00:00"));
    await fireTimers(c);

    expect(c.cars.get("UNKNOWN 1")!.status).toBe("unknown");
    expect(c.exitLanes.get("EXIT_EXIT")).toMatchObject({ passageOwner: "UNKNOWN 1", passageState: "uncertain" });
    expect(sim.charges()).toEqual([]);
    expect(sim.gotos()).toEqual([]);
    expect(store.getIncidentByCorrelation("unknown_visit", "UNKNOWN 1")?.status).toBe("open");
  });

  it("only releases an uncertain Level 2 reservation after an explicit fresh empty-sensor review", async () => {
    const { c, sim, advance, store } = await make({ cfg: { webhookProfile: "level2", maxGotoResends: 0 } });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    wait(advance, c, c.cfg.gotoConfirmGameS + 1);
    await c.tick();
    const car = c.cars.get("A")!;
    const incidentId = store.getIncidentByCorrelation("uncertain_reservation", car.visit_id!)!.id;

    sim.spots.find((spot) => spot.name === "S1")!.detectedCars = 1;
    const held = await c.reviewUncertainReservation(car.visit_id!, "request-held-001", car.state_version!, "detector still reports a car", "oper");
    expect(held.ok).toBe(false);
    expect(c.spots.get("S1")!.reserved_for).toBe("A");

    sim.spots.find((spot) => spot.name === "S1")!.detectedCars = 0;
    const duplicate = await c.reviewUncertainReservation(car.visit_id!, "request-held-001", car.state_version!, "retry same decision", "oper");
    expect(duplicate.ok).toBe(false); // same request ID retains its original outcome
    const cleared = await c.reviewUncertainReservation(car.visit_id!, "request-clear-001", car.state_version!, "operator visually confirms empty bay", "oper");
    expect(cleared.ok).toBe(true);
    expect(c.cars.has("A")).toBe(false);
    expect(c.spots.get("S1")!.reserved_for).toBeNull();
    expect(store.getIncident(incidentId)?.status).toBe("resolved");
    expect(store.searchSessions({ plate: "A" })[0]).toMatchObject({ status: "lost", payment_ok: null });
  });

  it("re-sends leavepark to a paid car still on the exit sensor, holding the gate open for it", async () => {
    // 21:31:06 run: AAA 509 paid, its leavepark was dropped; gateB closed after 6 s and the
    // car sat on EXIT_EXIT for another minute.
    const { c, sim, advance } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), gateEv("gateB", "Open"));
    const leaves = () => sim.gotos().filter((g) => g[1] === "A" && g[2] === "leavepark");
    expect(leaves()).toHaveLength(1);
    wait(advance, c, c.cfg.gotoConfirmGameS + 0.5);
    await c.tick();
    expect(leaves()).toHaveLength(2);
    expect(sim.calls).not.toContainEqual(["close", "gateB"]);
    await c.handle(carEv("A", "EXIT_EXIT", "CarOut", "10:03:20"));
    expect(c.cars.has("A")).toBe(false);
  });

  it("re-sends leavepark to a turned-away car still on the entry sensor", async () => {
    const { c, sim, advance } = await make({ sim: FakeSim.lvl1(1) });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"), carEv("A", "ENTRY1", "CarOut", "10:00:01"),
      carEv("B", "ENTRY1", "CarIn", "10:00:05")); // full: B is turned away
    expect(sim.gotos().at(-1)).toEqual(["goto", "B", "leavepark"]);
    wait(advance, c, c.cfg.gotoConfirmGameS + 0.5);
    await c.tick();
    expect(sim.gotos().filter((g) => g[1] === "B")).toHaveLength(2);
    await c.handle(carEv("B", "ENTRY1", "CarOut", "10:00:08"));
    expect(c.cars.has("B")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lost webhooks & vanished cars
// ---------------------------------------------------------------------------
describe("lost webhooks", () => {
  const back = (c: Controller, plate: string, field: "releasedG" | "parkedG" | "arrivedG" | "lastSeenG", gameS: number) => {
    c.cars.get(plate)![field]! -= gameS + 1;
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

  it("holds an uncertain exit passage for operator clearance when CarOut is lost", async () => {
    const { c, sim } = await make();
    c.gates.get("gateB")!.state = "Closed";
    await parkAndReachExit(c);
    await fireTimers(c);
    await feed(c, payEv("A", 2), gateEv("gateB", "Open")); // released; its exit CarOut never arrives
    expect(c.gateBusy("gateB")).toBe(true);
    await c.tick();
    expect(sim.calls).not.toContainEqual(["close", "gateB"]); // not yet: it may still be driving out
    back(c, "A", "releasedG", c.cfg.releaseTimeoutGameS);
    await c.tick();
    expect(sim.calls).not.toContainEqual(["close", "gateB"]); // do not close over a possibly uncleared car
    expect(c.cars.has("A")).toBe(false);
    expect(c.completed.at(-1)).toMatchObject({ plate: "A", status: "gone", payment_ok: true });
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ passage_owner: "A", passage_state: "uncertain" });
    expect((await c.confirmExitClearance("EXIT_EXIT", "", "oper")).ok).toBe(false);
    expect((await c.confirmExitClearance("EXIT_EXIT", "camera confirms lane clear", "oper")).ok).toBe(true);
    expect(sim.last()).toEqual(["close", "gateB"]);
    await c.handle(gateEv("gateB", "Closed"));
    expect(c.snapshot().exit_lanes[0]).toMatchObject({ passage_owner: null, passage_state: "idle" });
  });

  it("requires loopback-only webhook ingress for the Level 2 checksum profile", () => {
    expect(() => loadSettings({ GPA_WEBHOOK_PROFILE: "level2", GPA_WEBHOOK_LOOPBACK_ONLY: "false" }))
      .toThrow(/must remain true for Level 2/);
  });

  it("rehydrates visits beyond the replay window and quarantines an uncorroborated reservation", async () => {
    const store = new Store(":memory:");
    const now = new Date().toISOString();
    const parked = (visitId: string, plate: string, spot: string) => ({ visit_id: visitId, plate, car_type: "Normal",
      planned_minutes: 5, status: "parked", entry_lane: "ENTRY1", exit_lane: null, arrived_at: now, spot,
      parked_at: now, left_spot_at: null, exit_at: null, charge_parking: null, charge_electric: null,
      charge_attempts: 0, charge_override: null, invoice_id: null, invoice_status: "none", paid: null,
      payment_ok: null, left_at: null });
    for (const [id, plate, spot] of [["visit-a", "A", "S1"], ["visit-b", "B", "S2"]]) {
      store.saveVisitState(parked(id, plate, spot));
    }
    const sim = FakeSim.lvl1();
    for (const s of sim.spots) s.detectedCars = s.name === "S1" ? 1 : 0;
    const c = new Controller({ sim, cfg: testSettings({ webhookProfile: "level2" }), store, log: silentLog,
      topologies: [LVL1], queue: new RecordingQueue() });
    await c.sync();
    expect(c.cars.get("A")!.status).toBe("parked");
    expect(c.spots.get("S1")!.occupant).toBe("A");
    expect(c.cars.get("B")!.status).toBe("unknown");
    expect(c.spots.get("S2")!.reserved_for).toBe("B");
    expect(c.spots.get("S2")!.available).toBe(false);
    expect(store.listIncidents().some((incident) => incident.type === "uncertain_reservation" && incident.plate === "B")).toBe(true);
  });

  it("does not release a replayed Level 2 parked space merely because the live detector reports zero", async () => {
    const store = new Store(":memory:");
    const now = new Date().toISOString();
    for (const event of [
      carEv("PARKED", "ENTRY1", "CarIn", "10:00:00"),
      carEv("PARKED", "ENTRY1", "CarOut", "10:00:02"),
      carEv("PARKED", "S1", "CarIn", "10:00:05"),
    ]) store.recordEvent({ ...event, _received_at: now, _accepted: true });
    const sim = FakeSim.lvl1();
    for (const s of sim.spots) s.detectedCars = 0;
    const c = new Controller({ sim, cfg: testSettings({ webhookProfile: "level2" }), store, log: silentLog,
      topologies: [LVL1], queue: new RecordingQueue() });

    await c.sync({ replay: true });

    expect(c.cars.get("PARKED")?.status).toBe("parked");
    expect(c.spots.get("S1")?.occupant).toBe("PARKED");
    expect(c.spots.get("S1")?.available).toBe(false);
    expect(store.listIncidents({ status: "open" }).some((incident) => incident.type === "occupancy_evidence_conflict")).toBe(true);
  });

  it("does not assume an unconfirmed gate opened in the Level 2 profile", async () => {
    const { c, sim, advance, store } = await make({ cfg: { webhookProfile: "level2", gateConfirmGameS: 1 } });
    await c.handle(carEv("SAFE 1", "ENTRY1", "CarIn", "10:00:00"));
    advance(1.1);
    await c.tick();
    advance(1.1);
    await c.tick();
    expect(sim.gotos()).not.toContainEqual(["goto", "SAFE 1", "S1"]);
    expect(c.gates.get("gateA")!.state).toBe("Opening");
    expect(store.listIncidents().some((i) => i.type === "uncertain_gate_open")).toBe(true);
  });

  it("retires a parked car well past its planned stay", async () => {
    const { c } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00", "2"), carEv("A", "ENTRY1", "CarOut", "10:00:02", "2"),
      { ...carEv("A", "S1", "CarIn", "10:00:05", "2"), _received_at: new Date().toISOString() });
    back(c, "A", "parkedG", 120 + c.cfg.parkedOverstayGameS - 30);
    await c.tick();
    expect(c.cars.get("A")!.status).toBe("parked"); // late, but within the margin
    back(c, "A", "parkedG", 60);
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
    back(c, "A", "lastSeenG", c.cfg.staleCarGameS);
    back(c, "Q", "arrivedG", c.cfg.entryPatienceGameS + 60); // Q's "gave up" CarOut was lost
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
    c.cars.get("ARA 545")!.gotoG! -= c.cfg.gotoConfirmGameS + 1;
    await c.tick(); // a re-send goes to the new spot, never back to S1
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
