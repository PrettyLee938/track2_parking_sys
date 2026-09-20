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
    const { c, sim, store } = await make();
    await c.handle(broken("BarrierGate", "gateA"));
    expect(repairs(sim)).toEqual([["repair", "gateA"]]);
    expect(c.gates.get("gateA")!.maintenance).toBe(true);
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00")); // arrives during the repair
    expect(sim.calls.filter((x) => x[0] === "open")).toEqual([]); // operating it now is a penalty
    expect(c.entryLanes.get("ENTRY1")!.queue).toEqual(["A"]);
    await c.handle(fixed("BarrierGate", "gateA"));
    expect(store.listMaintenanceJobs().map((j) => j.status)).toEqual(["completed"]);
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

  it("does not repair spots early while their zone is nearly full", async () => {
    // 04:02 run: a dozen empty spots went into early repair while 70 cars/min were turned away.
    const { c, sim } = await make({ cfg: { spotUseLimit: 12, spotRepairMinFree: 1 } });
    for (let i = 0; i < 10; i++) await feed(c, carEv(`V${i}`, "S1", "CarIn", "10:00:00"), carEv(`V${i}`, "S1", "CarOut", "10:01:00"));
    await c.handle(carEv("P", "S2", "CarIn", "10:02:00")); // S1 (10/12, empty) and S3 free: 2 free
    c.spots.get("S3")!.reserved_for = "Q"; // now only S1 is free
    await c.tick();
    expect(repairs(sim)).toEqual([]); // the zone needs it
    c.spots.get("S3")!.reserved_for = null;
    await c.tick();
    expect(repairs(sim)).toEqual([["repair", "S1"]]); // spare room again: repair it early
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

  const zone1 = (level: number) => [{ name: "ZONE1", gasCarbonMonoxideLevel: level, risk: level >= 50 ? "Mid" : "Safe" }];
  const fanCalls = (sim: FakeSim) => sim.calls.filter((x) => x[0].startsWith("fan-"));

  it("runs a zone's fans while its CO is 50 or more, and switches them off once it drops below", async () => {
    // Spec: "better to turn off when CO levels are below 50". 2026-09-20: no CO webhook ever
    // came - only "High CO gas level" penalties (30 each) - so the level is read (list-zones).
    // Both thresholds are pinned so this tests the rule, not whatever the deployment has
    // configured: the defaults have been retuned twice and silently broke this test.
    const { c, sim, advance } = await make({ sim: withFans(), cfg: { gameSpeed: 1, coFanOnLevel: 50, coFanOffLevel: 50 } });
    sim.zones = zone1(20);
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00")); // traffic: worth measuring
    await c.tick();
    expect(sim.zonePolls).toBe(1);
    expect(fanCalls(sim)).toEqual([]); // 20: clean, fans stay off
    sim.zones = zone1(63);
    advance(c.cfg.coPollGameS);
    await c.tick();
    expect(fanCalls(sim)).toEqual([["fan-on", "fan0"], ["fan-on", "fan1"]]);
    sim.zones = zone1(49);
    advance(c.cfg.coPollGameS);
    await c.tick();
    expect(fanCalls(sim).slice(2)).toEqual([["fan-off", "fan0"], ["fan-off", "fan1"]]);
    expect(c.components.get("fan", "fan0")!.uses).toBeGreaterThan(0); // on-hours count as wear
  });

  it("keeps venting between the two thresholds so the fans do not chatter", async () => {
    // The shipped band is on at 50, off below 40: a reading in between must change nothing,
    // or a zone hovering around 50 would switch its fans on and off every poll.
    const { c, sim, advance } = await make({ sim: withFans(), cfg: { gameSpeed: 1, coFanOnLevel: 50, coFanOffLevel: 40 } });
    sim.zones = zone1(55);
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    await c.tick();
    expect(fanCalls(sim)).toEqual([["fan-on", "fan0"], ["fan-on", "fan1"]]);

    sim.zones = zone1(45); // inside the band: still venting
    advance(c.cfg.coPollGameS);
    await c.tick();
    expect(fanCalls(sim)).toHaveLength(2);

    sim.zones = zone1(39); // below the off level at last
    advance(c.cfg.coPollGameS);
    await c.tick();
    expect(fanCalls(sim).slice(2)).toEqual([["fan-off", "fan0"], ["fan-off", "fan1"]]);
  });

  it("does not poll CO while nothing moves and no fan runs", async () => {
    const { c, sim, advance } = await make({ sim: withFans(), cfg: { gameSpeed: 1 } });
    advance(c.cfg.coPollGameS * 3);
    await c.tick();
    expect(sim.zonePolls).toBe(0); // every list call has a cost
  });

  it("vents after a CO penalty until a reading is clean, and never switches a broken fan", async () => {
    const { c, sim, advance } = await make({ sim: withFans(), cfg: { gameSpeed: 1 } });
    sim.zones = zone1(70);
    await c.handle(broken("ExhaustFan", "fan1"));
    await c.handle({ EventClass: "penalty", Reason: "High CO gas level detected", FineAmount: "30", ComponentName: "ZONE1", EventId: "co1", _received_at: "" });
    await c.tick();
    expect(fanCalls(sim)).toEqual([["fan-on", "fan0"]]); // fan1 is broken: never touched
    sim.zones = zone1(30);
    advance(c.cfg.coPollGameS);
    await c.tick();
    expect(fanCalls(sim)).toEqual([["fan-on", "fan0"], ["fan-off", "fan0"]]);
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

  it("keeps asking a car that fakes its payment more than once", async () => {
    // 04:44 run: ZLP 294, BCA 039 and LCC 468 faked twice; asked only once more, each sat on
    // the exit fined every ~45 s.
    const { c, sim } = await make();
    await parkAndReachExit(c);
    await fireTimers(c);
    const fake = async () => {
      c.submitRejected({ ...payEv("A", 2), Signature: "0".repeat(32), _sig: "invalid" });
      await (c.queue as RecordingQueue).tasks.at(-1)!();
      await fireTimers(c);
    };
    await fake();
    await fake();
    expect(sim.charges()).toHaveLength(3); // the bill + a re-ask after each fake
    await c.handle(payEv("A", 2));
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

describe("lights", () => {
  // Spec: lights guide drivers in dark zones and cost electricity - "make sure they run
  // only at night", "no need to be on if all cars are parking, they must be on if a car is
  // moving in the zone". So the rule is movement, not occupancy.
  const withLights = () => {
    const sim = FakeSim.lvl1();
    sim.lights = ["l1", "l2"].map((name) => ({ name, group: "G1", zoneParent: "ZONE1", isOn: false }));
    return sim;
  };
  const lightCalls = (sim: FakeSim) => sim.calls.filter((x) => /^(light|group)-/.test(x[0]));
  // No level file in tests, so there are no light positions: group mode is what runs.
  const night = { gameSpeed: 1, lightsDetail: "group" as const };

  it("leaves every light off in the daytime, however much traffic there is", async () => {
    const { c, sim } = await make({ sim: withLights(), cfg: night });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "12:00:00")); // midday
    await c.tick();
    expect(lightCalls(sim)).toEqual([]);
  });

  it("lights a zone at night while a car is driving in it", async () => {
    const { c, sim } = await make({ sim: withLights(), cfg: night });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00")); // night: the car is dispatched
    await c.tick();
    expect(lightCalls(sim)).toEqual([["group-on", "G1"]]);
    expect(c.components.get("light", "l1")!.on).toBe(true);
  });

  it("switches them off again once every car has parked", async () => {
    const { c, sim, advance } = await make({ sim: withLights(), cfg: night });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();
    expect(lightCalls(sim)).toEqual([["group-on", "G1"]]);

    await c.handle(carEv("A", "S1", "CarIn", "22:00:20")); // parked: nothing is moving now
    advance(c.cfg.lightsHoldGameS + 1);                    // the anti-flicker hold expires
    await c.tick();
    expect(lightCalls(sim)).toEqual([["group-on", "G1"], ["group-off", "G1"]]);
  });

  it("keeps them on between cars, so a stream does not flicker them", async () => {
    const { c, sim, advance } = await make({ sim: withLights(), cfg: night });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();
    await c.handle(carEv("A", "S1", "CarIn", "22:00:10"));  // A parks
    advance(c.cfg.lightsHoldGameS / 2);                     // still inside the hold
    await c.tick();
    expect(lightCalls(sim)).toEqual([["group-on", "G1"]]);  // not switched off yet
  });

  it("lights up again when a parked car leaves", async () => {
    const { c, sim, advance } = await make({ sim: withLights(), cfg: night });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();                                        // lights come on for the arrival
    await c.handle(carEv("A", "S1", "CarIn", "22:00:20"));
    advance(c.cfg.lightsHoldGameS + 1);
    await c.tick();
    expect(lightCalls(sim).at(-1)).toEqual(["group-off", "G1"]);

    await c.handle(carEv("A", "S1", "CarOut", "22:05:00")); // driving to the exit
    await c.tick();
    expect(lightCalls(sim).at(-1)).toEqual(["group-on", "G1"]);
  });

  it("switches everything off when nothing has moved for the idle timeout", async () => {
    const { c, sim, advance } = await make({ sim: withLights(), cfg: { ...night, lightsHoldGameS: 10_000 } });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();
    expect(lightCalls(sim)).toEqual([["group-on", "G1"]]);

    // The hold alone would keep them on; the park-wide idle rule overrides it.
    advance(c.cfg.lightsIdleOffGameS + 1);
    await c.tick();
    expect(lightCalls(sim).at(-1)).toEqual(["group-off", "G1"]);
  });

  it("never operates a broken light, not even inside a group command", async () => {
    const { c, sim } = await make({ sim: withLights(), cfg: night });
    await c.handle(broken("Light", "l1"));
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();
    // A group command operates every light in the group, so with one broken the others are
    // switched individually instead - operating a broken part is a penalty.
    expect(lightCalls(sim)).toEqual([["light-on", "l2"]]);
    expect(c.components.get("light", "l1")!.on).toBe(false);
    expect(c.components.get("light", "l2")!.on).toBe(true);
  });

  it("counts on-time as usage, the way fans are measured", async () => {
    const { c, sim, advance } = await make({ sim: withLights(), cfg: night });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();
    advance(3600); // an hour of game time with the lights on
    await c.tick();
    expect(c.components.get("light", "l1")!.uses).toBeGreaterThan(0);
  });

  it("can be turned off entirely, or forced on whatever the hour", async () => {
    const off = await make({ sim: withLights(), cfg: { ...night, lightsMode: "never" } });
    await off.c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await off.c.tick();
    expect(lightCalls(off.sim)).toEqual([]);

    const always = await make({ sim: withLights(), cfg: { ...night, lightsMode: "always" } });
    await always.c.handle(carEv("A", "ENTRY1", "CarIn", "12:00:00")); // midday
    await always.c.tick();
    expect(lightCalls(always.sim)).toEqual([["group-on", "G1"]]);
  });
});

describe("manual control of fans and lights", () => {
  // Same contract as a gate: On/Off hold the part where the operator put it, Automatic
  // hands it back. Anything the simulator would fine us for is refused with the reason.
  const rig = async (cfg: Record<string, unknown> = {}) => {
    const sim = FakeSim.lvl1();
    sim.fans = [{ name: "fan0", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: false }];
    sim.lights = [{ name: "l1", group: "G1", zoneParent: "ZONE1", isOn: false }];
    const ctx = await make({ sim, cfg: { gameSpeed: 1, lightsDetail: "group" as const, ...cfg } });
    return ctx;
  };
  const calls = (sim: FakeSim, prefix: string) => sim.calls.filter((x) => x[0].startsWith(prefix));
  const holds = (c: Awaited<ReturnType<typeof rig>>["c"]) =>
    (c.snapshot().environment?.holds ?? []).map((h) => `${h.kind}:${h.name}=${h.hold}`);

  it("switches a light on and keeps it on against the automatic rules", async () => {
    const { c, sim, advance } = await rig();
    expect(await c.manualDevice("light", "l1", "on", "alice")).toMatchObject({ ok: true });
    expect(calls(sim, "light-on")).toEqual([["light-on", "l1"]]);
    expect(holds(c)).toEqual(["light:l1=on"]);

    // Daytime would normally switch every light off; the hold survives it.
    await c.handle(carEv("A", "ENTRY1", "CarIn", "12:00:00"));
    advance(c.cfg.lightsIdleOffGameS + 1);
    await c.tick();
    expect(calls(sim, "light-off")).toEqual([]);
    expect(calls(sim, "group-off")).toEqual([]);
  });

  /**
   * The group command is all-or-nothing, so it cannot say "all on except this one". While
   * the whole group was switched together it undid the hold on the very next tick, and a
   * light could not be held off at all from the dashboard (reported 2026-09-20). With the
   * group split, the lights are switched one by one instead.
   */
  it("holds one light off while the rest of its group is lit", async () => {
    const sim = FakeSim.lvl1();
    sim.lights = ["l1", "l2", "l3"].map((name) => ({ name, group: "G1", zoneParent: "ZONE1", isOn: false }));
    const { c, advance } = await make({ sim, cfg: { gameSpeed: 1, lightsDetail: "group" as const } });

    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00")); // night: the zone wants light
    await c.tick();
    expect(sim.calls).toContainEqual(["group-on", "G1"]);

    expect(await c.manualDevice("light", "l2", "off", "alice")).toMatchObject({ ok: true });
    sim.calls.length = 0;
    advance(1);
    await c.tick();

    // The tick must not reach for the group command again - that would switch l2 back on.
    expect(sim.calls.filter((x) => x[0] === "group-on")).toEqual([]);
    expect(c.components.get("light", "l2")!.on).toBe(false);
    expect(c.components.get("light", "l1")!.on).toBe(true);
  });

  it("switches an ungrouped light individually rather than skipping it", async () => {
    const sim = FakeSim.lvl1();
    sim.lights = [{ name: "loose", group: "", zoneParent: "ZONE1", isOn: false }];
    const { c } = await make({ sim, cfg: { gameSpeed: 1, lightsDetail: "group" as const } });
    await c.handle(carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    await c.tick();
    expect(sim.calls.filter((x) => /^(light|group)-/.test(x[0]))).toEqual([["light-on", "loose"]]);
  });

  it("hands a light back to the daylight rules on auto", async () => {
    const { c, sim } = await rig();
    await c.manualDevice("light", "l1", "on", "alice");
    sim.calls.length = 0;
    expect(await c.manualDevice("light", "l1", "auto", "alice")).toMatchObject({ ok: true });
    expect(holds(c)).toEqual([]);
    await c.tick(); // daytime, nothing moving: the light goes off again
    expect(calls(sim, "group-off").length + calls(sim, "light-off").length).toBeGreaterThan(0);
  });

  it("holds a fan on even though its zone is clean", async () => {
    const { c, sim, advance } = await rig();
    sim.zones = [{ name: "ZONE1", gasCarbonMonoxideLevel: 5, risk: "Safe" }];
    expect(await c.manualDevice("fan", "fan0", "on", "alice")).toMatchObject({ ok: true });
    expect(calls(sim, "fan-on")).toEqual([["fan-on", "fan0"]]);
    advance(c.cfg.coPollGameS * 2);
    await c.tick();
    expect(calls(sim, "fan-off")).toEqual([]); // an idle fan only costs wear: the hold stands
  });

  it("refuses to switch a fan off while its zone is above the CO level", async () => {
    const { c, sim, advance } = await rig();
    sim.zones = [{ name: "ZONE1", gasCarbonMonoxideLevel: 70, risk: "Mid" }];
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    await c.tick();
    expect(calls(sim, "fan-on")).toEqual([["fan-on", "fan0"]]);

    const res = await c.manualDevice("fan", "fan0", "off", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/CO level/);
    expect(holds(c)).toEqual([]);
    void advance;
  });

  it("releases a fan held off once its zone goes bad - ventilation is a safety function", async () => {
    const { c, sim, advance } = await rig();
    sim.zones = [{ name: "ZONE1", gasCarbonMonoxideLevel: 5, risk: "Safe" }];
    expect(await c.manualDevice("fan", "fan0", "off", "alice")).toMatchObject({ ok: true });
    expect(holds(c)).toEqual(["fan:fan0=off"]);

    sim.zones = [{ name: "ZONE1", gasCarbonMonoxideLevel: 70, risk: "Mid" }];
    await c.handle(carEv("A", "S1", "CarIn", "10:00:00"));
    advance(c.cfg.coPollGameS);
    await c.tick();
    expect(holds(c)).toEqual([]);
    expect(calls(sim, "fan-on")).toEqual([["fan-on", "fan0"]]);
  });

  it("never operates a part that is out of service, and reports unknown ones", async () => {
    const { c, sim } = await rig();
    await c.handle(broken("ExhaustFan", "fan0"));
    // A breakdown starts a repair at once, so by now it is "maintenance" rather than
    // "broken" - operating it is a penalty either way, which is what is refused.
    const res = await c.manualDevice("fan", "fan0", "on", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/penalty/);
    expect(calls(sim, "fan-on")).toEqual([]);
    expect(await c.manualDevice("light", "nope", "on", "alice")).toMatchObject({ ok: false });
  });

  it("records who did it in the audit trail", async () => {
    const { c, store } = await rig();
    await c.manualDevice("light", "l1", "on", "alice");
    const row = store.db.prepare("SELECT args, actor FROM actions WHERE cmd = 'light-on'").get() as { actor: string };
    expect(row.actor).toBe("alice");
  });
});

describe("repairing fans and lights", () => {
  const rig = async () => {
    const sim = FakeSim.lvl1();
    sim.fans = [{ name: "f_0", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, isOn: false }];
    sim.lights = [{ name: "t_0", group: "G1", zoneParent: "ZONE1", isOn: false }];
    return make({ sim, cfg: { gameSpeed: 1, lightsDetail: "group" as const } });
  };

  it("repairs a fan through the simulator", async () => {
    const { c, sim } = await rig();
    expect(await c.manualComponentRepair("fan", "f_0", "alice")).toMatchObject({ ok: true });
    expect(repairs(sim)).toEqual([["repair", "f_0"]]);
    expect(c.components.usable("fan", "f_0")).toBe(false); // under repair
  });

  it("refuses to repair a running fan - that is a penalty", async () => {
    const { c, sim } = await rig();
    await c.manualDevice("fan", "f_0", "on", "alice");
    sim.calls.length = 0;
    const res = await c.manualComponentRepair("fan", "f_0", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/operating/);
    expect(repairs(sim)).toEqual([]);
  });

  /**
   * Verified against the simulator on 2026-09-20: POST /lights/{name}/repair,
   * /lights/group/{g}/repair and /lights/{name}/fix all answer 404, while
   * /exhaust-fans/{name}/repair answers 201. So a faulty light is put on record instead.
   */
  it("records a faulty light as an incident, since the simulator cannot repair one", async () => {
    const { c, sim, store } = await rig();
    const res = await c.manualComponentRepair("light", "t_0", "alice");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/incident #\d+/);
    expect(repairs(sim)).toEqual([]); // no command was invented for it

    const [incident] = store.listIncidents({ status: "open" });
    expect(incident).toMatchObject({ kind: "light_fault", component: "t_0", zone: "ZONE1", status: "open" });
    expect(incident.reason).toContain("alice");
  });

  it("points at the incident already open instead of raising duplicates", async () => {
    const { c, store } = await rig();
    const first = await c.manualComponentRepair("light", "t_0", "alice");
    const again = await c.manualComponentRepair("light", "t_0", "bob");
    expect(again.message).toMatch(/already reported/);
    expect(again.message).toContain(first.message.match(/#(\d+)/)![0]);
    expect(store.listIncidents({ status: "open" })).toHaveLength(1);
  });

  it("writes the report to the audit trail", async () => {
    const { c, store } = await rig();
    await c.manualComponentRepair("light", "t_0", "alice");
    const entry = store.listAudit(50).find((a) => a.action === "light.fault_reported");
    expect(entry).toMatchObject({ actor: "alice", target: "t_0", ok: true });
  });

  /**
   * The button raised an incident and nothing else, so the Maintenance page never changed
   * and it read as a dead button (reported 2026-09-20). A light is the one part with no
   * repair command, so the job stays waiting for clearance: nothing will complete it.
   */
  it("shows the report in the maintenance history", async () => {
    const { c, store } = await rig();
    await c.manualComponentRepair("light", "t_0", "alice");
    const job = store.listMaintenanceJobs(50).find((j) => j.component_name === "t_0");
    expect(job).toMatchObject({ component_kind: "light", status: "waiting_for_clearance", actor: "alice" });
    expect(job!.reason).toMatch(/no light repair command/);
  });

  it("does not stack a second job on the same light", async () => {
    const { c, store } = await rig();
    await c.manualComponentRepair("light", "t_0", "alice");
    await c.manualComponentRepair("light", "t_0", "bob");
    expect(store.listMaintenanceJobs(50).filter((j) => j.component_name === "t_0")).toHaveLength(1);
  });

  it("reports an unknown part rather than guessing", async () => {
    const { c } = await rig();
    expect(await c.manualComponentRepair("light", "nope", "alice")).toMatchObject({ ok: false });
    expect(await c.manualComponentRepair("fan", "nope", "alice")).toMatchObject({ ok: false });
  });
});
