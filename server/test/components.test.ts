/** Component health (Level 2): breakdowns, automatic repairs, never using broken parts. */
import { describe, expect, it } from "vitest";
import { Controller } from "../src/controller";
import type { EventRecord } from "../src/store";
import { carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, RecordingQueue, silentLog } from "./helpers";

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

  it("keeps working when the level has no fans or lights to list (Level 1)", async () => {
    const sim = FakeSim.lvl1();
    sim.listExhaustFans = async () => { throw new Error("404"); };
    const { c } = await make({ sim });
    expect(c.components.views().filter((v) => v.kind === "gate")).toHaveLength(3);
    expect(c.feed.some((f) => f.msg.includes("could not list fans/lights"))).toBe(true);
  });
});
