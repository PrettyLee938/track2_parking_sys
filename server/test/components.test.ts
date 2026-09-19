/** Component health (Level 2): breakdowns, automatic repairs, never using broken parts. */
import { describe, expect, it } from "vitest";
import { Controller } from "../src/controller";
import type { EventRecord } from "../src/store";
import {
  carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, RecordingQueue, silentLog, testServer,
} from "./helpers";

let n = 0;
const broken = (type: string, name: string, fine = "20.00"): EventRecord =>
  ({ EventClass: "component_broken", Type: type, Name: name, FineAmount: fine, EventId: `cb${++n}`, _received_at: "" });
const fixed = (type: string, name: string): EventRecord =>
  ({ EventClass: "component_fixed", Type: type, Name: name, RepairCost: "10.00", EventId: `cf${++n}`, _received_at: "" });
const repairs = (sim: FakeSim) => sim.calls.filter((c) => c[0] === "repair");

describe("component health", () => {
  it("repairs a broken entry gate straight away and resumes the lane once it is fixed", async () => {
    // 2026-09-20 01:14 Level 2 run: gate1 broke a minute in, nothing repaired it, and the
    // only entrance stayed shut for 12 minutes.
    const { c, sim } = await make();
    await c.handle(broken("BarrierGate", "gateA"));
    expect(repairs(sim)).toEqual([["repair", "gateA"]]);
    expect(c.gates.get("gateA")!.maintenance).toBe(true);
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00")); // arrives during the repair
    expect(sim.calls.filter((x) => x[0] === "open")).toEqual([]); // operating it now is a penalty
    expect(c.entryLanes.get("ENTRY1")!.queue).toEqual(["A"]);
    await c.handle(fixed("BarrierGate", "gateA"));
    expect(sim.last()).toEqual(["open", "gateA"]);
    await c.handle(gateEv("gateA", "Open"));
    expect(sim.last()).toEqual(["goto", "A", "S1"]);
    expect(c.components.views().find((v) => v.name === "gateA")).toMatchObject({ health: "ok", breakdowns: 1, uses: 1 });
  });

  it("waits for a car driving through a broken gate before repairing it", async () => {
    const { c, sim } = await make();
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00")); // A is sent through
    await c.handle(broken("BarrierGate", "gateA"));
    expect(repairs(sim)).toEqual([]);
    expect(c.components.views().find((v) => v.name === "gateA")!.waiting).toBe("A is driving through");
    await c.handle(carEv("A", "ENTRY1", "CarOut", "10:00:02"));
    await c.tick();
    expect(repairs(sim)).toEqual([["repair", "gateA"]]);
  });

  it("holds a paid car at a broken exit gate, then lets it out once the gate is fixed", async () => {
    const { c, sim } = await make();
    c.gates.get("gateB")!.state = "Closed";
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(broken("BarrierGate", "gateB"));
    expect(repairs(sim)).toEqual([["repair", "gateB"]]);
    await c.handle(payEv("A", 2));
    expect(sim.calls).not.toContainEqual(["open", "gateB"]);
    expect(c.cars.get("A")!.status).toBe("released");
    await c.handle(fixed("BarrierGate", "gateB"));
    expect(sim.last()).toEqual(["open", "gateB"]);
    await c.handle(gateEv("gateB", "Open"));
    expect(sim.last()).toEqual(["goto", "A", "leavepark"]);
  });

  it("repairs a broken spot only once its car has left, and never sends cars to it", async () => {
    const { c, sim } = await make();
    await c.handle(carEv("P", "S1", "CarIn", "10:00:00"));
    await c.handle(broken("ParkingSpot", "S1", "10.00"));
    expect(repairs(sim)).toEqual([]); // repairing an occupied spot is a penalty
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:01"));
    expect(sim.last()).toEqual(["goto", "A", "S2"]);
    await c.handle(carEv("P", "S1", "CarOut", "10:02:00"));
    await c.tick();
    expect(repairs(sim)).toEqual([["repair", "S1"]]);
    expect(c.spots.get("S1")!.available).toBe(false); // under repair
    await c.handle(fixed("ParkingSpot", "S1"));
    expect(c.spots.get("S1")!.available).toBe(true);
  });

  it("tracks exhaust fans and lights, and repairs a broken fan", async () => {
    const sim = FakeSim.lvl1();
    sim.fans = [{ name: "fan0", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: true }];
    sim.lights = [{ name: "t_0", group: "G1", zoneParent: "ZONE1", isOn: true }];
    const { c } = await make({ sim });
    expect(c.components.views().filter((v) => v.kind === "fan" || v.kind === "light").map((v) => [v.name, v.health, v.on]))
      .toEqual([["fan0", "ok", true], ["t_0", "ok", true]]);
    await c.handle(broken("ExhaustFan", "fan0"));
    expect(repairs(sim)).toEqual([["repair", "fan0"]]);
    expect(c.components.usable("fan", "fan0")).toBe(false);
    await c.handle(fixed("ExhaustFan", "fan0"));
    expect(c.components.usable("fan", "fan0")).toBe(true);
  });

  it("retries a repair the simulator rejected", async () => {
    const { c, sim, advance } = await make({ cfg: { gameSpeed: 1 } });
    sim.failing.add("repair");
    await c.handle(broken("BarrierGate", "gateA"));
    expect(repairs(sim)).toHaveLength(1);
    await c.tick();
    expect(repairs(sim)).toHaveLength(1); // not hammering it
    sim.failing.clear();
    advance(c.cfg.repairRetryGameS + 1);
    await c.tick();
    expect(repairs(sim)).toHaveLength(2);
    expect(c.gates.get("gateA")!.maintenance).toBe(true);
  });

  it("records breakdowns and usage in the database, and keeps them across a restart", async () => {
    const { c, store } = await make();
    await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"));
    await c.handle(broken("BarrierGate", "gateA"));
    await c.tick();
    expect(store.listComponentEvents().map((e) => e.event)).toEqual(["repair_sent", "broken"]);
    expect(store.loadComponent("gate", "gateA")).toMatchObject({ uses: 2, breakdowns: 1, uses_at_breakdown: [2] });
    // A restart: a new controller on the same database starts from the saved usage.
    const again = new Controller({ sim: FakeSim.lvl1(), cfg: c.cfg, store, queue: new RecordingQueue(), log: silentLog, topologies: [LVL1] });
    await again.sync();
    expect(again.components.views().find((v) => v.name === "gateA")).toMatchObject({ uses_total: 2, breakdowns: 1 });
  });

  it("does not count replayed events twice", async () => {
    const { c, store } = await make();
    c.replaying = true;
    await feed(c, gateEv("gateA", "Open"), broken("BarrierGate", "gateA"));
    c.replaying = false;
    expect(store.listComponentEvents()).toEqual([]);
    expect(c.components.views().find((v) => v.name === "gateA")).toMatchObject({ uses: 0, breakdowns: 0 });
  });

  it("learns how many openings a gate survives from its breakdowns", async () => {
    const { c } = await make();
    expect(c.components.limit("gate")).toBeNull();
    for (let i = 0; i < 10; i++) await c.handle(gateEv("gateA", "Open"));
    await c.handle(broken("BarrierGate", "gateA"));
    expect(c.components.limit("gate")).toBe(10); // 2026-09-20: 10 of 10 breakdowns on the 10th opening
  });

  it("repairs a gate before its breaking opening instead of opening it", async () => {
    const { c, sim } = await make({ cfg: { gateCycleLimit: 10 } });
    for (let i = 0; i < 9; i++) await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed")); // 9 openings
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls.filter((x) => x[0] === "open")).toEqual([]); // the 10th opening would break it
    await c.tick();
    expect(repairs(sim)).toEqual([["repair", "gateA"]]);
    expect(c.store.listComponentEvents()[0]).toMatchObject({ event: "preventive_repair", name: "gateA" });
    await c.handle(fixed("BarrierGate", "gateA"));
    expect(sim.last()).toEqual(["open", "gateA"]); // A goes in once it is repaired
    expect(c.components.views().find((v) => v.name === "gateA")).toMatchObject({ uses: 0, breakdowns: 0 });
  });

  it("repairs a well-worn gate early while nobody needs it, but not while cars wait", async () => {
    const { c, sim } = await make({ cfg: { gateCycleLimit: 10, preventiveIdleRatio: 0.8 } });
    for (let i = 0; i < 8; i++) await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00")); // opening 9, A in the lane
    await c.tick();
    expect(repairs(sim)).toEqual([]); // in demand: keep using it while it is open
    await c.handle(carEv("A", "ENTRY1", "CarOut", "10:00:02"));
    await c.tick();
    expect(repairs(sim)).toEqual([["repair", "gateA"]]); // idle now, and one more opening would break it
  });

  it("starts usage from zero when the simulator restarts the level with new parts", async () => {
    // 2026-09-20 02:26: the simulator was restarted (Level 2 is not saved: all gates new), but
    // gate1 was still "11 openings" in our books - held shut as worn out, no car got in.
    const { c, sim, store } = await make({ cfg: { gateCycleLimit: 10 } });
    for (let i = 0; i < 11; i++) await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    expect(c.components.wornOut("gate", "gateA")).toBe(true);
    const spots = sim.spots;
    sim.spots = []; // restarted: on the menu...
    await c.sync();
    sim.spots = spots; // ...then the level is started again
    await c.sync();
    expect(c.components.views().find((v) => v.name === "gateA")).toMatchObject({ uses: 0, uses_total: 11 });
    expect(store.loadComponent("gate", "gateA")!.uses).toBe(0);
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.last()).toEqual(["open", "gateA"]);
  });

  it("uses a worn gate anyway when the simulator refuses its preventive repair", async () => {
    const { c, sim } = await make({ cfg: { gateCycleLimit: 10 } });
    for (let i = 0; i < 9; i++) await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    sim.failing.add("repair");
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls.filter((x) => x[0] === "repair")).toHaveLength(1);
    expect(c.components.wornOut("gate", "gateA")).toBe(false); // a dead lane is worse than a breakdown
    await c.tick();
    expect(sim.last()).toEqual(["open", "gateA"]);
  });

  it("lets out paid cars that waited through an exit gate's preventive repair", async () => {
    // 2026-09-20 03:03: gate2 went into preventive repair while idle; three cars paid during
    // it and were never let out once it was fixed - they left on their own minutes later.
    const { c, sim, advance } = await make({ cfg: { gateCycleLimit: 10, gameSpeed: 1 } });
    for (let i = 0; i < 8; i++) await feed(c, gateEv("gateB", "Closed"), gateEv("gateB", "Open"));
    await c.tick(); // idle and 8/10: preventive repair
    expect(repairs(sim)).toEqual([["repair", "gateB"]]);
    await parkAndReachExit(c);
    await fireTimers(c);
    await c.handle(payEv("A", 2));
    expect(sim.gotos().filter((g) => g[2] === "leavepark")).toEqual([]); // gate under repair
    advance(c.cfg.releaseTimeoutGameS + 30); // a repair takes ~35 s: longer than the release timeout
    await c.tick();
    expect(c.cars.get("A")?.status).toBe("released"); // still waiting, not written off
    await c.handle(fixed("BarrierGate", "gateB"));
    await fireTimers(c);
    const after = sim.calls.slice(sim.calls.findIndex((x) => x[0] === "charge") + 1);
    expect(after).toContainEqual(["goto", "A", "leavepark"]);
    expect(after.filter((x) => x[0] === "close" && x[1] === "gateB")).toEqual([]);
  });

  it("keeps working when the level has no fans or lights to list (Level 1)", async () => {
    const sim = FakeSim.lvl1();
    sim.listExhaustFans = async () => { throw new Error("404"); };
    const { c } = await make({ sim });
    expect(c.components.views().filter((v) => v.kind === "gate")).toHaveLength(3);
    expect(c.feed.some((f) => f.msg.includes("could not list fans/lights"))).toBe(true);
  });
});

describe("exhaust fans", () => {
  const withFans = () => {
    const sim = FakeSim.lvl1();
    sim.fans = ["fan0", "fan1"].map((name) => ({ name, zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: false }));
    return sim;
  };

  it("runs a zone's fans while cars move in it, and switches them off once it is quiet", async () => {
    // 2026-09-20 03:12: no CO event ever came - only "High CO gas level" penalties (30 each).
    const { c, sim, advance } = await make({ sim: withFans(), cfg: { gameSpeed: 1 } });
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    await c.tick();
    expect(sim.calls.filter((x) => x[0] === "fan-on").map((x) => x[1])).toEqual(["fan0", "fan1"]);
    advance(c.cfg.fanIdleOffGameS + 1);
    await c.tick();
    expect(sim.calls.filter((x) => x[0] === "fan-off").map((x) => x[1])).toEqual(["fan0", "fan1"]);
    expect(c.components.views().find((v) => v.name === "fan0")!.uses).toBeGreaterThan(0); // on-hours count as wear
  });

  it("keeps fans on after a CO penalty, and never switches a broken fan", async () => {
    const { c, sim, advance } = await make({ sim: withFans(), cfg: { gameSpeed: 1 } });
    await c.handle(broken("ExhaustFan", "fan1"));
    await c.handle({ EventClass: "penalty", Reason: "High CO gas level detected", FineAmount: "30", ComponentName: "ZONE1", EventId: "co1", _received_at: "" });
    advance(c.cfg.fanIdleOffGameS + 1); // quiet, but the alert holds
    await c.tick();
    expect(sim.calls.filter((x) => x[0].startsWith("fan-"))).toEqual([["fan-on", "fan0"]]); // fan1 is broken: never touched
  });
});

describe("fake payments", () => {
  it("never releases a car for a payment with a bad signature, and asks it to pay once more", async () => {
    // 2026-09-20: six payments had a bad signature; each car sat unpaid at the exit and was
    // fined every ~3 min as "escaped without paying".
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "A", 2, 0]]);
    c.submitRejected({ ...payEv("A", 2), Signature: "f99787f8972b89bdeee80a9434a0eb6c", _sig: "invalid" });
    await (c.queue as RecordingQueue).tasks.at(-1)!();
    expect(c.counters.fake_payments).toBe(1);
    expect(sim.gotos().filter((g) => g[2] === "leavepark")).toEqual([]);
    await fireTimers(c);
    expect(sim.charges()).toEqual([["charge", "A", 2, 0], ["charge", "A", 2, 0]]); // asked again, same amount
    await c.handle(payEv("A", 2)); // a real payment this time
    expect(sim.last()).toEqual(["goto", "A", "leavepark"]);
  });

  it("hands a badly signed payment to the controller without acting on it", async () => {
    const { app, queue } = await testServer({ cfg: { signatureMode: "strict" } });
    const body = JSON.stringify({ EventClass: "payment_made", CarPlateNumber: "VWW 515", Amount: "4.00", Reason: "Car Payment",
      EventId: "x1", SequenceId: "1", Signature: "f99787f8972b89bdeee80a9434a0eb6c", ServerDateTime: "2026-09-20 01:59:32" });
    await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: body });
    expect(queue.tasks).toHaveLength(1); // submitRejected, not submit: see the test above
  });
});
