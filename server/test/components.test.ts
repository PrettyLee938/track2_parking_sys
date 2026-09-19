/**
 * The component layer: usage cycles, preventive maintenance, CO-driven ventilation,
 * daylight-driven lighting, and tracking broken components of every kind.
 */
import { describe, expect, it } from "vitest";
import { AirQuality, WearBook, ageSinceService, devicesFrom, isDaytime, wearRatio, wearSinceRepair } from "../src/components";
import { TUNABLES, outOfRangeTunables } from "../src/config";
import { Store } from "../src/store";
import {
  carEv, coEv, componentEv, fan, feed, fireTimers, gateEv, light, make, spot, testSettings, FakeSim, gate,
} from "./helpers";

const THRESHOLDS = { gateCycles: 10, spotCycles: 5, deviceRuntimeGameS: 100, deviceCycles: 20 };

describe("wear book", () => {
  it("counts cycles and runtime per component", () => {
    const book = new WearBook();
    book.countCycle("gate", "gateA", "ZONE1");
    book.countCycle("gate", "gateA");
    book.addRuntime("fan", "F1", 30, "ZONE1");
    expect(book.get("gate", "gateA").cycles).toBe(2);
    expect(book.get("gate", "gateA").zone).toBe("ZONE1");
    expect(book.get("fan", "F1").runtime_game_s).toBe(30);
    // A light and a fan may share a name without sharing a counter.
    book.countCycle("light", "F1");
    expect(book.get("fan", "F1").cycles).toBe(0);
  });

  it("measures wear since the last repair, not since the beginning", () => {
    const book = new WearBook();
    for (let i = 0; i < 12; i++) book.countCycle("gate", "gateA");
    expect(wearRatio(book.get("gate", "gateA"), THRESHOLDS)).toBeGreaterThan(1);

    book.markRepaired("gate", "gateA", "2026-09-20T00:00:00Z");
    const w = book.get("gate", "gateA");
    expect(w.cycles).toBe(12);              // lifetime total is kept
    expect(wearSinceRepair(w).cycles).toBe(0); // but the service clock restarts
    expect(wearRatio(w, THRESHOLDS)).toBe(0);
    expect(w.repairs).toBe(1);
  });

  it("lists what is due, worst first", () => {
    const book = new WearBook();
    for (let i = 0; i < 10; i++) book.countCycle("gate", "barely");
    for (let i = 0; i < 30; i++) book.countCycle("gate", "badly");
    for (let i = 0; i < 3; i++) book.countCycle("gate", "fine");
    expect(book.due(THRESHOLDS).map((w) => w.name)).toEqual(["badly", "barely"]);
  });

  it("treats a zero threshold as 'never schedule this kind'", () => {
    const book = new WearBook();
    for (let i = 0; i < 99; i++) book.countCycle("spot", "S1");
    expect(book.due({ ...THRESHOLDS, spotCycles: 0 })).toEqual([]);
  });
});

describe("carbon monoxide", () => {
  const air = () => new AirQuality(() => ({ onPpm: 50, offPpm: 30, trustDangerWord: true }));

  it("starts ventilating above the on threshold and stops only below the off threshold", () => {
    const a = air();
    expect(a.update("Z1", 20, "Normal", "t").air.ventilating).toBe(false);
    expect(a.update("Z1", 55, "Normal", "t").air.ventilating).toBe(true);
    // Between the two thresholds it keeps running - this is the whole point of hysteresis.
    expect(a.update("Z1", 40, "Normal", "t").air.ventilating).toBe(true);
    expect(a.update("Z1", 31, "Normal", "t").air.ventilating).toBe(true);
    expect(a.update("Z1", 29, "Normal", "t").air.ventilating).toBe(false);
  });

  it("reports a change only on a transition, so fans are not re-commanded per reading", () => {
    const a = air();
    expect(a.update("Z1", 60, "Normal", "t").changed).toBe(true);
    expect(a.update("Z1", 61, "Normal", "t").changed).toBe(false);
    expect(a.update("Z1", 62, "Normal", "t").changed).toBe(false);
    expect(a.update("Z1", 10, "Normal", "t").changed).toBe(true);
  });

  it("acts on a danger word even when the number is low", () => {
    const a = air();
    expect(a.update("Z1", 5, "High", "t").air.ventilating).toBe(true);
  });

  it("keeps zones independent and tracks peak and excursions", () => {
    const a = air();
    a.update("Z1", 80, "Normal", "t");
    a.update("Z2", 10, "Normal", "t");
    expect(a.ventilating()).toEqual(["Z1"]);
    a.update("Z1", 90, "Normal", "t");
    expect(a.get("Z1")).toMatchObject({ peak: 90, excursions: 2 });
    expect(a.get("Z2")).toMatchObject({ peak: 10, excursions: 0 });
  });
});

describe("daylight", () => {
  it("reads the hour out of a simulator stamp", () => {
    expect(isDaytime("2026-09-19 12:00:00", 7, 19)).toBe(true);
    expect(isDaytime("2026-09-19 06:59:00", 7, 19)).toBe(false);
    expect(isDaytime("2026-09-19 19:00:00", 7, 19)).toBe(false);
    expect(isDaytime("2026-09-19 18:59:00", 7, 19)).toBe(true);
  });

  it("handles a window that wraps midnight, and unknown stamps", () => {
    expect(isDaytime("2026-09-19 23:00:00", 22, 5)).toBe(true);
    expect(isDaytime("2026-09-19 03:00:00", 22, 5)).toBe(true);
    expect(isDaytime("2026-09-19 12:00:00", 22, 5)).toBe(false);
    expect(isDaytime(null, 7, 19)).toBe(null);
    expect(isDaytime("no clock here", 7, 19)).toBe(null);
  });
});

describe("device discovery", () => {
  it("accepts the field spellings the simulator might use", () => {
    const rows = [
      { name: "L1", zoneParent: "ZONE1", isOn: true },
      { Name: "L2", ZoneName: "ZONE2", state: "On" },
      { name: "L3", zone: "ZONE3", status: false, broken: true },
    ];
    expect(devicesFrom("light", rows).map((d) => [d.name, d.zone, d.on, d.broken])).toEqual([
      ["L1", "ZONE1", true, false],
      ["L2", "ZONE2", true, false],
      ["L3", "ZONE3", false, true],
    ]);
  });

  it("ignores rows with no name, and a non-array response", () => {
    expect(devicesFrom("fan", [{ zoneParent: "Z" }])).toEqual([]);
    expect(devicesFrom("fan", null)).toEqual([]);
    expect(devicesFrom("fan", { error: "no such endpoint" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the controller wired to all of it
// ---------------------------------------------------------------------------
/**
 * Tests that assert an on/off *transition* pin their own thresholds: inheriting the
 * default makes them fail whenever someone tunes it, which says nothing about the code.
 */
const CO = { coOnPpm: 50, coOffPpm: 30 };

function lvl2Sim() {
  const sim = FakeSim.lvl1();
  sim.lights = [light("L1", "ZONE1"), light("L2", "ZONE1")];
  sim.fans = [fan("F1", "ZONE1"), fan("F2", "ZONE2")];
  return sim;
}

describe("controller: components", () => {
  it("discovers lights and fans at sync", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    expect(c.devices.size).toBe(4);
    expect(c.snapshot().devices.map((d) => `${d.kind}:${d.name}`)).toEqual(["fan:F1", "fan:F2", "light:L1", "light:L2"]);
  });

  it("tracks a broken exhaust fan, which used to be dropped on the floor", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    await feed(c, componentEv("ExhaustFan", "F1", true));
    expect(c.devices.get("fan:F1")!.broken).toBe(true);
    expect(c.counters.breakdowns).toBe(1);
    expect(c.wear.get("fan", "F1").breakdowns).toBe(1);
    const view = c.snapshot().components.find((w) => w.kind === "fan" && w.name === "F1");
    expect(view).toMatchObject({ broken: true, breakdowns: 1 });

    await feed(c, componentEv("ExhaustFan", "F1", false));
    expect(c.devices.get("fan:F1")!.broken).toBe(false);
  });

  it("records a broken component the list-* call never returned", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    await feed(c, componentEv("Light", "L99", true));
    expect(c.devices.get("light:L99")).toMatchObject({ broken: true });
  });

  it("switches a zone's fans on above the CO threshold and off below it", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { coOnPpm: 50, coOffPpm: 30 } });
    await feed(c, coEv("ZONE1", 70));
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]); // only ZONE1's fan
    expect(c.devices.get("fan:F1")!.on).toBe(true);
    expect(c.devices.get("fan:F2")!.on).toBe(false);

    // Still above the off threshold: no new command.
    await feed(c, coEv("ZONE1", 40));
    expect(sim.of("fan-off")).toHaveLength(0);

    await feed(c, coEv("ZONE1", 10));
    expect(sim.of("fan-off").map((call) => call[1])).toEqual(["F1"]);
    expect(c.counters.ventilation_changes).toBe(2);
  });

  it("counts a fan's on-off as one usage cycle each way and banks its runtime", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    await feed(c, coEv("ZONE1", 90));
    await feed(c, coEv("ZONE1", 5));
    expect(c.wear.get("fan", "F1").cycles).toBe(2);
    expect(sim.of("fan-on")).toHaveLength(1);
    expect(sim.of("fan-off")).toHaveLength(1);
  });

  it("never operates a broken fan", async () => {
    const { c, sim } = await make({ sim: lvl2Sim() });
    await feed(c, componentEv("ExhaustFan", "F1", true));
    await feed(c, coEv("ZONE1", 90));
    expect(sim.of("fan-on")).toHaveLength(0);
  });

  it("turns lights on at night and off by day", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { daylightFromHour: 7, daylightToHour: 19 } });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    expect(c.daytime).toBe(false);
    expect(sim.of("light-on").map((call) => call[1]).sort()).toEqual(["L1", "L2"]);

    await feed(c, carEv("B", "ENTRY1", "CarIn", "09:00:00"));
    expect(c.daytime).toBe(true);
    expect(sim.of("light-off").map((call) => call[1]).sort()).toEqual(["L1", "L2"]);
    expect(c.counters.light_changes).toBe(4);
  });

  it("leaves lights alone when told not to follow daylight", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { lightsFollowDaylight: false } });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "22:00:00"));
    expect(sim.of("light-on")).toHaveLength(0);
  });

  it("counts a gate cycle per confirmed open, not per command", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    await feed(c, gateEv("gateA", "Opening"), gateEv("gateA", "Open"));
    expect(c.wear.get("gate", "gateA").cycles).toBe(1);
    // Repeating the Open state is not a second use.
    await feed(c, gateEv("gateA", "Open"));
    expect(c.wear.get("gate", "gateA").cycles).toBe(1);
    await feed(c, gateEv("gateA", "Closed"), gateEv("gateA", "Open"));
    expect(c.wear.get("gate", "gateA").cycles).toBe(2);
  });

  it("counts a spot cycle each time a car parks", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    await feed(c, carEv("A", "S1", "CarIn", "10:00:00"), carEv("A", "S1", "CarOut", "10:05:00"));
    await feed(c, carEv("B", "S1", "CarIn", "10:06:00"));
    expect(c.wear.get("spot", "S1").cycles).toBe(2);
  });
});

describe("controller: preventive maintenance", () => {
  const worn = { maintGateCycles: 2, maintSpotCycles: 2, maintIntervalGameS: 0, closeIdleGatesOnSync: false };

  it("repairs a worn gate that is idle, before it breaks", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: worn });
    await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    expect(c.wear.get("gate", "gateA").cycles).toBe(2);

    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).toContain("gateA");
    expect(c.counters.preventive_repairs).toBe(1);
    // The service clock restarts, so it is not repaired again next sweep.
    expect(c.wear.get("gate", "gateA").cycles_at_repair).toBe(2);
    const before = sim.of("repair").length;
    await fireTimers(c);
    expect(sim.of("repair")).toHaveLength(before);
  });

  it("will not repair a gate a car is using", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: worn });
    await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00")); // queues on gateA's lane
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).not.toContain("gateA");
  });

  it("will not repair an occupied spot", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: worn });
    await feed(c, carEv("A", "S1", "CarIn", "10:00:00"), carEv("A", "S1", "CarOut", "10:01:00"));
    await feed(c, carEv("B", "S1", "CarIn", "10:02:00")); // still parked
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).not.toContain("S1");
  });

  /**
   * Regression: the budget used to count everything out of service, so one component stuck
   * broken (or under maintenance from before we started) vetoed preventive work in its
   * whole zone forever - the surest way to lose the rest of it too.
   */
  it("is not blocked by a component that was already out of service", async () => {
    const sim = lvl2Sim();
    sim.spots = [spot("S1"), spot("S2"), { ...spot("S9"), isUnderMaintenance: true },
      spot("ENTRY1", "EntrySpot", ""), spot("EXIT_EXIT", "ExitSpot")];
    const { c, sim: s } = await make({ sim, cfg: { ...worn, maintMaxConcurrentPerZone: 1 } });
    expect(c.snapshot().spots.find((x) => x.name === "S9")!.maintenance).toBe(true);

    await feed(c, carEv("a", "S1", "CarIn", "10:00:00"), carEv("a", "S1", "CarOut", "10:01:00"));
    await feed(c, carEv("b", "S1", "CarIn", "10:02:00"), carEv("b", "S1", "CarOut", "10:03:00"));
    await fireTimers(c);
    expect(s.of("repair").map((call) => call[1])).toContain("S1");
  });

  it("frees a slot once the simulator reports our component fixed", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { ...worn, maintMaxConcurrentPerZone: 1 } });
    await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    await fireTimers(c);
    expect(c.counters.preventive_repairs).toBe(1);

    // A second component becomes due while the first is still being serviced.
    await feed(c, carEv("a", "S1", "CarIn", "10:00:00"), carEv("a", "S1", "CarOut", "10:01:00"));
    await feed(c, carEv("b", "S1", "CarIn", "10:02:00"), carEv("b", "S1", "CarOut", "10:03:00"));
    await fireTimers(c);
    expect(c.counters.preventive_repairs).toBe(1); // budget full

    await feed(c, componentEv("BarrierGate", "gateA", false)); // gateA fixed, slot freed
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).toContain("S1");
  });

  it("keeps a zone's capacity by servicing one component at a time", async () => {
    const sim = lvl2Sim();
    sim.spots = [spot("S1"), spot("S2"), spot("S3"), spot("ENTRY1", "EntrySpot", ""), spot("EXIT_EXIT", "ExitSpot")];
    const { c } = await make({ sim, cfg: { ...worn, maintMaxConcurrentPerZone: 1 } });
    for (const s of ["S1", "S2", "S3"]) {
      await feed(c, carEv(`a${s}`, s, "CarIn", "10:00:00"), carEv(`a${s}`, s, "CarOut", "10:01:00"));
      await feed(c, carEv(`b${s}`, s, "CarIn", "10:02:00"), carEv(`b${s}`, s, "CarOut", "10:03:00"));
    }
    await fireTimers(c);
    expect(c.counters.preventive_repairs).toBe(1);
  });

  it("does nothing at all when preventive maintenance is off", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { ...worn, preventiveMaintenance: false } });
    await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"), gateEv("gateA", "Closed"));
    await fireTimers(c);
    expect(sim.of("repair")).toHaveLength(0);
    // Wear is still tracked and shown - we just do not act on it.
    expect(c.snapshot().components.find((w) => w.name === "gateA")!.ratio).toBeGreaterThanOrEqual(1);
  });

  it("will not pull the fan a zone is relying on right now", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { ...worn, maintDeviceCycles: 1 } });
    await feed(c, coEv("ZONE1", 90)); // F1 on, one cycle, now "due"
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).not.toContain("F1");
  });
});

describe("controller: wear survives a restart", () => {
  const noMaint = { preventiveMaintenance: false };

  it("resumes the service clock from the database", async () => {
    const store = new Store(":memory:");
    const { c } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    await feed(c, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"));
    expect(c.wear.get("gate", "gateA").cycles).toBe(2);
    await fireTimers(c); // persistWear runs on the tick

    // A second controller on the same database is a restart mid-run.
    const { c: resumed } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    expect(resumed.wear.get("gate", "gateA").cycles).toBe(2);
  });

  /**
   * Regression: a restart replays recent events through the handlers *and* loads the wear
   * book from the database. Counting during replay double-counted every cycle - a gate on
   * 5 came back on 10, which would trigger maintenance that was never earned.
   */
  it("does not count the events it replays a second time", async () => {
    const store = new Store(":memory:");
    const { c } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    // Events must be in the store for replay to find them, as the webhook route records them.
    const events = [gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"),
      gateEv("gateA", "Closed"), gateEv("gateA", "Open")];
    for (const e of events) {
      e._received_at = new Date().toISOString();
      e._accepted = true;
      store.recordEvent(e);
      await c.handle(e);
    }
    expect(c.wear.get("gate", "gateA").cycles).toBe(3);
    await fireTimers(c);

    const { c: resumed } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    await resumed.sync({ replay: true });
    expect(resumed.wear.get("gate", "gateA").cycles).toBe(3); // not 6
  });

  it("keeps counting from where it left off after the replay", async () => {
    const store = new Store(":memory:");
    const { c } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    for (const e of [gateEv("gateA", "Open"), gateEv("gateA", "Closed")]) {
      e._received_at = new Date().toISOString();
      e._accepted = true;
      store.recordEvent(e);
      await c.handle(e);
    }
    await fireTimers(c);

    const { c: resumed } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    await resumed.sync({ replay: true });
    await feed(resumed, gateEv("gateA", "Open"), gateEv("gateA", "Closed"), gateEv("gateA", "Open"));
    expect(resumed.wear.get("gate", "gateA").cycles).toBe(3);
  });

  it("does not re-count a breakdown it replays", async () => {
    const store = new Store(":memory:");
    const { c } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    const e = componentEv("ExhaustFan", "F1", true);
    e._accepted = true;
    store.recordEvent(e);
    await c.handle(e);
    expect(c.wear.get("fan", "F1").breakdowns).toBe(1);
    await fireTimers(c);

    const { c: resumed } = await make({ sim: lvl2Sim(), store, cfg: noMaint });
    await resumed.sync({ replay: true });
    expect(resumed.wear.get("fan", "F1").breakdowns).toBe(1);
  });
});

describe("controller: a broken entry gate", () => {
  /**
   * The exact deadlock seen on a live Level 2 run: the first zone's entry gate breaks,
   * cars queue behind it, and the repair is refused as "in use" - forever, because the
   * queue can only drain through the gate that is broken.
   */
  async function jammed(cfg: Record<string, unknown> = {}) {
    const ctx = await make({ sim: lvl2Sim(), cfg: { autoRepairBroken: false, ...cfg } });
    await feed(ctx.c, componentEv("BarrierGate", "gateA", true));
    // Three cars arrive at the entrance the broken gate serves.
    for (const plate of ["A", "B", "C"]) await feed(ctx.c, carEv(plate, "ENTRY1", "CarIn", "10:00:00"));
    const lane = ctx.c.entryLanes.get("ENTRY1")!;
    expect(lane.queue.length).toBeGreaterThan(0);
    expect(ctx.c.gates.get("gateA")!.broken).toBe(true);
    return ctx;
  }

  it("can be repaired by hand even with cars queued behind it", async () => {
    const { c, sim } = await jammed();
    const res = await c.manualGate("gateA", "repair", "alice");
    expect(res.ok).toBe(true);
    expect(sim.of("repair").map((call) => call[1])).toContain("gateA");
  });

  it("is repaired automatically, without waiting for an operator", async () => {
    const { c, sim } = await make({ sim: lvl2Sim() });
    await feed(c, componentEv("BarrierGate", "gateA", true));
    for (const plate of ["A", "B"]) await feed(c, carEv(plate, "ENTRY1", "CarIn", "10:00:00"));
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).toContain("gateA");
    expect(c.counters.reactive_repairs).toBe(1);
  });

  it("lets the queue drain once the gate is reported fixed", async () => {
    const { c, sim } = await jammed();
    await c.manualGate("gateA", "repair", "alice");
    sim.calls.length = 0;
    await feed(c, componentEv("BarrierGate", "gateA", false));
    expect(c.gates.get("gateA")!.broken).toBe(false);
    expect(c.gates.get("gateA")!.maintenance).toBe(false);
    // The entrance starts moving again: a gate open for the first queued car.
    expect(sim.of("open").map((call) => call[1])).toContain("gateA");
  });

  it("still refuses to repair a working gate a car is crossing", async () => {
    const { c, sim } = await make({ sim: lvl2Sim() });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(c.entryLanes.get("ENTRY1")!.current).toBe("A"); // dispatched, on the sensor
    const res = await c.manualGate("gateA", "repair", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/crossing/);
    expect(sim.of("repair")).toHaveLength(0);
  });

  it("repairs a working gate that merely has cars queued, not crossing", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    const lane = c.entryLanes.get("ENTRY1")!;
    lane.queue.push("Z"); // waiting, but nobody is under the barrier
    expect(await c.manualGate("gateA", "repair", "alice")).toMatchObject({ ok: true });
  });

  it("re-sends a repair the simulator dropped", async () => {
    const { c, sim, advance } = await make({ sim: lvl2Sim(), cfg: { repairRetryGameS: 10 } });
    await feed(c, componentEv("BarrierGate", "gateA", true));
    await fireTimers(c);
    expect(sim.of("repair")).toHaveLength(1);

    await fireTimers(c); // too soon: no spam
    expect(sim.of("repair")).toHaveLength(1);

    advance(11); // still broken after the retry window
    await fireTimers(c);
    expect(sim.of("repair")).toHaveLength(2);
  });

  it("never repairs an occupied spot, the one in-use rule the spec states", async () => {
    const { c, sim } = await make({ sim: lvl2Sim() });
    await feed(c, carEv("A", "S1", "CarIn", "10:00:00"));   // car parked in S1
    await feed(c, componentEv("ParkingSpot", "S1", true));  // and now S1 breaks
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).not.toContain("S1");

    await feed(c, carEv("A", "S1", "CarOut", "10:05:00"));  // car leaves
    await fireTimers(c);
    expect(sim.of("repair").map((call) => call[1])).toContain("S1");
  });

  it("can be turned off for a run that wants manual control only", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { autoRepairBroken: false } });
    await feed(c, componentEv("BarrierGate", "gateA", true));
    await fireTimers(c);
    expect(sim.of("repair")).toHaveLength(0);
  });
});

describe("controller: reconcile after a sync", () => {
  /**
   * Regression: a sync takes the simulator's word for every device state, and the apply
   * loops only fire on a transition. Without a reconcile at the end of sync, a fan whose
   * zone needs ventilation stays off until CO happens to cross a threshold again.
   */
  it("re-asserts ventilation for a zone that still needs it", async () => {
    const sim = lvl2Sim();
    const { c } = await make({ sim });
    await feed(c, coEv("ZONE1", 90));
    expect(c.devices.get("fan:F1")!.on).toBe(true);

    // The simulator now reports the fan as off (restart, manual change, lost command).
    sim.fans = [fan("F1", "ZONE1", false), fan("F2", "ZONE2", false)];
    sim.calls.length = 0;
    await c.sync();
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("re-asserts lighting, which replay sets but deliberately does not act on", async () => {
    const sim = lvl2Sim();
    const { c } = await make({ sim });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "23:00:00")); // night
    sim.lights = [light("L1", "ZONE1", false), light("L2", "ZONE1", false)];
    sim.calls.length = 0;
    await c.sync();
    expect(sim.of("light-on").map((call) => call[1]).sort()).toEqual(["L1", "L2"]);
  });

  it("sends nothing when the simulator already agrees", async () => {
    const sim = lvl2Sim();
    const { c } = await make({ sim });
    await feed(c, coEv("ZONE1", 90));
    sim.calls.length = 0;
    await c.sync(); // sim still reports F1 on? it does not - but nothing else should move
    expect(sim.of("light-on")).toHaveLength(0);
    expect(sim.of("fan-off")).toHaveLength(0);
  });
});

describe("controller: manual device control", () => {
  it("switches a fan by hand and holds it against the automation", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    expect(await c.manualDevice("fan", "F1", "on", "alice")).toMatchObject({ ok: true });
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);

    // The CO loop would normally switch it off; the hold wins.
    await feed(c, coEv("ZONE1", 5));
    expect(sim.of("fan-off")).toHaveLength(0);

    expect(await c.manualDevice("fan", "F1", "auto", "alice")).toMatchObject({ ok: true });
    expect(sim.of("fan-off").map((call) => call[1])).toEqual(["F1"]);
  });

  it("refuses to operate a broken device, and names why", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    await feed(c, componentEv("ExhaustFan", "F1", true));
    const res = await c.manualDevice("fan", "F1", "on", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/broken/);
  });

  it("refuses to repair a fan its zone currently needs", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    await feed(c, coEv("ZONE1", 90));
    const res = await c.manualDevice("fan", "F1", "repair", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ventilation/i);
  });

  it("reports an unknown device rather than guessing", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    expect(await c.manualDevice("light", "nope", "on", "alice")).toMatchObject({ ok: false });
  });
});

describe("controller: levels without lights or fans", () => {
  it("runs normally when the endpoints return nothing", async () => {
    const { c, sim } = await make(); // plain lvl1 fake: no lights, no fans
    expect(c.devices.size).toBe(0);
    await feed(c, coEv("ZONE1", 200, "High"));
    expect(sim.of("fan-on")).toHaveLength(0);
    // The reading is still recorded, so the dashboard shows the zone is dangerous.
    expect(c.snapshot().air).toMatchObject([{ zone: "ZONE1", level: 200, ventilating: true }]);
  });

  it("survives a simulator that has no such endpoint at all", async () => {
    const sim = new FakeSim([spot("S1"), spot("ENTRY1", "EntrySpot", ""), spot("EXIT_EXIT", "ExitSpot")],
      [gate("gateA"), gate("gateB", "Open")]);
    // Endpoints removed, as on a level that predates them.
    (sim as { listLights?: unknown }).listLights = undefined;
    (sim as { listExhaustFans?: unknown }).listExhaustFans = undefined;
    const { c } = await make({ sim });
    expect(c.devices.size).toBe(0);
    expect(c.snapshot().devices).toEqual([]);
  });
});

describe("controller: live-tunable settings", () => {
  it("applies a new CO threshold to the zones already being watched", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { coOnPpm: 80, coOffPpm: 60 } });
    await feed(c, coEv("ZONE1", 70)); // below 80: no ventilation
    expect(sim.of("fan-on")).toHaveLength(0);

    // Lowering the threshold must act on the reading we already have, not wait for
    // the next one - a quiet zone might not send another for minutes.
    expect(await c.updateSettings({ coOnPpm: 50 }, "alice")).toMatchObject({ ok: true });
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("refuses a stop threshold above the start threshold", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    const res = await c.updateSettings({ coOnPpm: 40, coOffPpm: 90 }, "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/never stop/);
    expect(c.cfg.coOnPpm).not.toBe(40); // nothing applied
  });

  it("rejects a key that is not tunable at runtime", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    const res = await c.updateSettings({ simPassword: "hunter2" }, "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not a runtime setting/);
    expect(c.cfg.simPassword).not.toBe("hunter2");
  });

  it("rejects a value outside the allowed range", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    expect(await c.updateSettings({ daylightFromHour: 99 }, "alice")).toMatchObject({ ok: false });
    expect(await c.updateSettings({ maintMaxConcurrentPerZone: 0 }, "alice")).toMatchObject({ ok: false });
  });

  it("re-lights immediately when the daylight window moves", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { daylightFromHour: 7, daylightToHour: 19 } });
    await feed(c, carEv("A", "ENTRY1", "CarIn", "20:00:00")); // night: lights on
    expect(sim.of("light-on")).toHaveLength(2);
    sim.calls.length = 0;

    // Extend daylight past 20:00 - the lights should go off without another event.
    await c.updateSettings({ daylightToHour: 22 }, "alice");
    expect(sim.of("light-off").map((call) => call[1]).sort()).toEqual(["L1", "L2"]);
  });

  it("keeps a tuned value across a restart", async () => {
    const store = new Store(":memory:");
    const { c } = await make({ sim: lvl2Sim(), store });
    await c.updateSettings({ coOnPpm: 42 }, "alice");
    expect(c.cfg.coOnPpm).toBe(42);

    const { c: resumed } = await make({ sim: lvl2Sim(), store });
    expect(resumed.cfg.coOnPpm).toBe(42);
  });

  it("records who changed what, for the audit trail", async () => {
    const store = new Store(":memory:");
    const { c } = await make({ sim: lvl2Sim(), store });
    await c.updateSettings({ coOnPpm: 55 }, "alice");
    const row = store.db.prepare("SELECT cmd, args, actor FROM actions WHERE cmd = 'settings'").get() as
      { cmd: string; args: string; actor: string };
    expect(row.actor).toBe("alice");
    expect(row.args).toContain("coOnPpm");
  });

  it("reports no change rather than pretending to do something", async () => {
    const { c } = await make({ sim: lvl2Sim(), cfg: { coOnPpm: 50 } });
    expect(await c.updateSettings({ coOnPpm: 50 }, "alice")).toMatchObject({ ok: true, message: "no change" });
  });
});

describe("controller: a fan with no zone", () => {
  /**
   * Regression: the simulator really does report zoneless components - its own
   * list-exhaust-fans example is `"name": "fan0", "zoneParent": ""`. Skipping those meant
   * a fan that could never be switched on however high CO went.
   */
  function zonelessSim() {
    const sim = FakeSim.lvl1();
    sim.fans = [fan("fan0", "")];
    return sim;
  }

  it("follows any zone that needs ventilation", async () => {
    const { c, sim } = await make({ sim: zonelessSim(), cfg: CO });
    expect(c.devices.get("fan:fan0")!.zone).toBe("");
    await feed(c, coEv("ZONE2", 90));
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["fan0"]);
  });

  it("stops once no zone needs it any more", async () => {
    const { c, sim } = await make({ sim: zonelessSim(), cfg: CO });
    await feed(c, coEv("ZONE1", 90));
    await feed(c, coEv("ZONE2", 90));
    expect(sim.of("fan-on")).toHaveLength(1); // one fan, one command
    await feed(c, coEv("ZONE1", 5));
    expect(sim.of("fan-off")).toHaveLength(0); // ZONE2 still needs it
    await feed(c, coEv("ZONE2", 5));
    expect(sim.of("fan-off").map((call) => call[1])).toEqual(["fan0"]);
  });

  it("explains why it is off, rather than leaving you guessing", async () => {
    const { c } = await make({ sim: zonelessSim(), cfg: CO });
    const reasonOf = () => c.snapshot().devices.find((d) => d.name === "fan0")!.reason;
    expect(reasonOf()).toMatch(/no CO readings yet/);

    await feed(c, coEv("ZONE1", 10));
    expect(reasonOf()).toMatch(/no zone is above/);

    await feed(c, coEv("ZONE1", 90));
    expect(reasonOf()).toMatch(/extracting: the park has a zone above/);

    await feed(c, componentEv("ExhaustFan", "fan0", true));
    expect(reasonOf()).toMatch(/broken/);
  });

  it("names the zone and level when a zoned fan is idle", async () => {
    const { c } = await make({ sim: lvl2Sim(), cfg: CO });
    await feed(c, coEv("ZONE1", 12));
    const reason = c.snapshot().devices.find((d) => d.name === "F1")!.reason;
    expect(reason).toContain("ZONE1");
    expect(reason).toContain("12");
    expect(reason).toContain("50"); // the threshold it is being measured against
  });

  it("matches zone names loosely, so casing cannot silently break ventilation", async () => {
    const sim = FakeSim.lvl1();
    sim.fans = [fan("F1", "ZONE1")];
    const { c, sim: s } = await make({ sim, cfg: CO });
    await feed(c, coEv("zone1", 90)); // simulator used a different casing
    expect(s.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("treats a Mid danger level as elevated, as the spec says", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { coOnPpm: 999, coOffPpm: 999 } });
    // The simulator only sends this event at Mid or above, so Mid already means act.
    await feed(c, coEv("ZONE1", 1, "Mid"));
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });
});

describe("controller: age-based service interval", () => {
  it("is off by default, since the simulator breaks things by usage not age", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    expect(c.cfg.maintMaxAgeS).toBe(0);
    expect(c.snapshot().components.every((w) => w.ratio === 0 || w.cycles > 0)).toBe(true);
  });

  it("makes every component due once it is old enough", async () => {
    const book = new WearBook();
    book.get("gate", "gateA");
    book.get("spot", "S1");
    book.get("light", "L1");
    const t = { ...THRESHOLDS, maxAgeS: 60 };
    const now = Date.now();
    expect(book.due(t, now)).toHaveLength(0);
    // 61 seconds later everything is past its age interval, whatever its usage.
    expect(book.due(t, now + 61_000).map((w) => w.name).sort()).toEqual(["L1", "S1", "gateA"]);
  });

  it("restarts the age clock at each repair", async () => {
    const book = new WearBook();
    const w = book.get("gate", "gateA");
    const t = { ...THRESHOLDS, maxAgeS: 60 };
    const now = Date.now();
    expect(book.due(t, now + 61_000)).toHaveLength(1);

    book.markRepaired("gate", "gateA", new Date(now + 61_000).toISOString());
    expect(book.due(t, now + 61_000)).toHaveLength(0);
    expect(ageSinceService(w, now + 61_000)).toBe(0);
    expect(book.due(t, now + 130_000)).toHaveLength(1);
  });

  it("reports age in the dashboard view", async () => {
    const { c } = await make({ sim: lvl2Sim() });
    const view = c.snapshot().components.find((w) => w.kind === "fan");
    expect(view).toBeDefined();
    expect(typeof view!.age_s).toBe("number");
  });
});

describe("controller: ventilation is self-healing", () => {
  /**
   * Regression: applyVentilation only ran when a reading *crossed* a threshold, so a fan
   * got exactly one chance to be switched. With a low stop threshold a busy zone never
   * transitions again, and anything that blocked that single attempt left the fan off for
   * the rest of the run. The tick now re-asserts the wanted state.
   */
  it("recovers with no further threshold crossing to trigger it", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    const realFanOn = sim.fanOn.bind(sim);
    let fail = true;
    sim.fanOn = async (n: string) => {
      if (fail) { fail = false; throw new Error("dropped"); }
      return realFanOn(n);
    };
    await feed(c, coEv("ZONE1", 90)); // the one crossing - and its command is dropped
    expect(c.devices.get("fan:F1")!.on).toBe(false);

    // Every later reading stays above the stop threshold, so air.update reports no change
    // and the old code would never call applyVentilation again.
    const before = c.counters.ventilation_changes;
    await feed(c, coEv("ZONE1", 85));
    await feed(c, coEv("ZONE1", 80));
    expect(c.counters.ventilation_changes).toBe(before);
    expect(c.devices.get("fan:F1")!.on).toBe(false);

    await fireTimers(c); // the tick is the only thing that can put it right
    expect(c.devices.get("fan:F1")!.on).toBe(true);
  });

  it("re-sends a ventilation command the simulator dropped", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    // The first fan-on fails at the transport, so our record stays "off".
    const realFanOn = sim.fanOn.bind(sim);
    let fail = true;
    sim.fanOn = async (n: string) => {
      if (fail) { fail = false; throw new Error("dropped"); }
      return realFanOn(n);
    };
    await feed(c, coEv("ZONE1", 90));
    expect(c.devices.get("fan:F1")!.on).toBe(false);

    await fireTimers(c);
    expect(c.devices.get("fan:F1")!.on).toBe(true);
  });

  it("sends nothing on a tick when every fan is already right", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    await feed(c, coEv("ZONE1", 90));
    expect(sim.of("fan-on")).toHaveLength(1);
    sim.calls.length = 0;
    await fireTimers(c);
    await fireTimers(c);
    expect(sim.calls.filter((call) => /fan|light/.test(String(call[0])))).toHaveLength(0);
  });

  it("still respects an operator hold on every tick", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    // Held ON: the zone does not need it, but an idle fan is only a usage cost, so the
    // re-assert must not undo the operator. (A hold OFF is a safety matter and is
    // released when the zone needs ventilation - see the hold tests below.)
    await c.manualDevice("fan", "F1", "on", "alice");
    sim.calls.length = 0;
    await feed(c, coEv("ZONE1", 1));
    await fireTimers(c);
    await fireTimers(c);
    expect(sim.of("fan-off")).toHaveLength(0);
    expect(c.devices.get("fan:F1")!.hold).toBe("on");
  });

  it("reports where the chain stops", async () => {
    const { c } = await make({ sim: lvl2Sim(), cfg: CO });
    let d = c.ventilationDiagnosis();
    expect(d).toMatchObject({ fans_discovered: 2, co_events_seen: 0, endpoint_available: true });
    expect(d.hint).toMatch(/No CO reading/);

    await feed(c, componentEv("ExhaustFan", "F1", true));
    await feed(c, coEv("ZONE1", 90));
    d = c.ventilationDiagnosis();
    expect(d.zones_wanting_ventilation).toEqual(["ZONE1"]);
    const f1 = d.fans.find((f) => f.name === "F1")!;
    expect(f1).toMatchObject({ should_be_on: true, on: false });
    expect(f1.blocked_by).toMatch(/broken/);
  });

  it("says so when no fans were discovered at all", async () => {
    const { c } = await make(); // plain lvl1 fake: no fans
    const d = c.ventilationDiagnosis();
    expect(d.fans_discovered).toBe(0);
    expect(d.hint).toMatch(/list-exhaust-fans/);
  });
});

describe("controller: an operator hold on a fan", () => {
  /**
   * A hold is what makes manual control stick - without it the automation would undo an
   * operator's decision a second later. But ventilation is a safety function: keeping a
   * fan *off* while its zone is polluted is Penalty_ZonePollutedWithHighCO, and nothing
   * ever reconsidered a hold, so one forgotten click caused it for the rest of the run.
   */
  it("keeps a fan running for as long as the operator wants", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    expect(await c.manualDevice("fan", "F1", "on", "alice")).toMatchObject({ ok: true });
    sim.calls.length = 0;
    // No zone needs it, but an idle fan only costs usage cycles - the hold stands.
    await feed(c, coEv("ZONE1", 1));
    await fireTimers(c);
    expect(sim.of("fan-off")).toHaveLength(0);
    expect(c.devices.get("fan:F1")!.hold).toBe("on");
  });

  it("refuses to switch a fan off while its zone is polluted", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    await feed(c, coEv("ZONE1", 90));
    expect(c.devices.get("fan:F1")!.on).toBe(true);
    sim.calls.length = 0;

    const res = await c.manualDevice("fan", "F1", "off", "alice");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/above the CO threshold/);
    expect(sim.of("fan-off")).toHaveLength(0);
    expect(c.devices.get("fan:F1")!.hold).toBe(null); // no hold was taken
  });

  it("releases a hold taken before the zone became polluted", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    // Air is clean, so switching it off by hand is allowed.
    await feed(c, coEv("ZONE1", 1));
    expect(await c.manualDevice("fan", "F1", "off", "alice")).toMatchObject({ ok: true });
    expect(c.devices.get("fan:F1")!.hold).toBe("off");
    sim.calls.length = 0;

    // Now the zone goes bad: the hold must not keep the fan off.
    await feed(c, coEv("ZONE1", 200, "Critical"));
    expect(c.devices.get("fan:F1")!.hold).toBe(null);
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("releases it on a tick too, not only on a reading", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    await feed(c, coEv("ZONE1", 1));
    await c.manualDevice("fan", "F1", "off", "alice");
    // Force the zone to want ventilation without a fresh transition through the handler.
    c.air.update("ZONE1", 200, "Critical", new Date().toISOString());
    sim.calls.length = 0;

    await fireTimers(c);
    expect(c.devices.get("fan:F1")!.hold).toBe(null);
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("leaves a light hold alone - lighting is not a safety function", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: { ...CO, daylightFromHour: 7, daylightToHour: 19 } });
    await c.manualDevice("light", "L1", "off", "alice");
    sim.calls.length = 0;
    await feed(c, carEv("A", "ENTRY1", "CarIn", "23:00:00")); // night: L2 on, L1 held off
    await fireTimers(c);
    expect(c.devices.get("light:L1")!.hold).toBe("off");
    expect(sim.of("light-on").map((call) => call[1])).toEqual(["L2"]);
  });

  it("returns to automatic on request", async () => {
    const { c, sim } = await make({ sim: lvl2Sim(), cfg: CO });
    await c.manualDevice("fan", "F1", "on", "alice");
    await feed(c, coEv("ZONE1", 1));
    sim.calls.length = 0;
    expect(await c.manualDevice("fan", "F1", "auto", "alice")).toMatchObject({ ok: true });
    expect(c.devices.get("fan:F1")!.hold).toBe(null);
    expect(sim.of("fan-off").map((call) => call[1])).toEqual(["F1"]);
  });
});

describe("controller: reading CO from the simulator", () => {
  /**
   * The simulator only SENDS carbon_monoxide_event at Mid (~50) and above, so a
   * webhook-only system never learns a zone is at 5, 20 or 40 - and a threshold below Mid
   * can never fire, however it is configured. Polling list-zones is the only way to see
   * those levels, and doubles as a safety net when a CO webhook is lost.
   */
  function pollingSim() {
    const sim = lvl2Sim();
    sim.zones = [
      { name: "ZONE1", gasCarbonMonoxideLevel: 0, risk: "Safe" },
      { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" },
    ];
    return sim;
  }
  const POLL = { coOnPpm: 5, coOffPpm: 3, zonePollGameS: 1 };

  it("can be turned off, and then says so in the diagnosis", async () => {
    const { c, sim } = await make({ sim: pollingSim(), cfg: { coOnPpm: 5, coOffPpm: 3, zonePollGameS: 0 } });
    sim.zones[0].gasCarbonMonoxideLevel = 40;
    await fireTimers(c);
    expect(c.air.all()).toHaveLength(0); // nothing polled, and no webhook would arrive at 40
    expect(JSON.stringify(c.ventilationDiagnosis().zone_poll)).toMatch(/off/);
  });

  it("acts on a level the simulator would never send an event for", async () => {
    const { c, sim } = await make({ sim: pollingSim(), cfg: POLL });
    sim.zones[0].gasCarbonMonoxideLevel = 8; // well below Mid: no webhook would ever arrive
    sim.zones[0].risk = "Safe";
    await fireTimers(c);
    expect(c.air.get("ZONE1")).toMatchObject({ level: 8, ventilating: true });
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("stops again once the polled level falls below the stop threshold", async () => {
    const { c, sim, advance } = await make({ sim: pollingSim(), cfg: POLL });
    sim.zones[0].gasCarbonMonoxideLevel = 8;
    await fireTimers(c);
    expect(sim.of("fan-on")).toHaveLength(1);

    sim.zones[0].gasCarbonMonoxideLevel = 1;
    advance(2); // the interval has to pass before the next poll is due
    await fireTimers(c);
    expect(sim.of("fan-off").map((call) => call[1])).toEqual(["F1"]);
  });

  it("does not poll more often than its interval", async () => {
    const { c, sim } = await make({ sim: pollingSim(), cfg: { ...POLL, zonePollGameS: 1000 } });
    sim.zones[0].gasCarbonMonoxideLevel = 8;
    await fireTimers(c);
    const polls = c.ventilationDiagnosis().zone_poll.polls;
    await fireTimers(c);
    await fireTimers(c);
    expect(c.ventilationDiagnosis().zone_poll.polls).toBe(polls);
  });

  it("keeps running when the endpoint fails", async () => {
    const { c, sim } = await make({ sim: pollingSim(), cfg: POLL });
    sim.listZones = async () => { throw new Error("no such endpoint"); };
    await fireTimers(c);
    expect(c.air.all()).toHaveLength(0);
    // and a webhook still works as before
    await feed(c, coEv("ZONE1", 90));
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
  });

  it("recovers a zone whose CO webhook was lost", async () => {
    const { c, sim } = await make({ sim: pollingSim(), cfg: POLL });
    // No webhook ever arrives for ZONE2, but the poll sees it.
    sim.zones[1].gasCarbonMonoxideLevel = 70;
    sim.zones[1].risk = "Mid";
    await fireTimers(c);
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F2"]);
  });
});

describe("settings bounds", () => {
  /**
   * Regression: min/max bound what an admin may *type*, not the value itself. Editing a
   * bound as if it were a value (max: 5 when the default is 50) left the setting above its
   * own ceiling, and every dashboard save was then rejected over a field nobody touched.
   */
  it("flags a tunable whose value sits outside its own bounds", async () => {
    const cfg = testSettings({ coOnPpm: 50 });
    expect(outOfRangeTunables(cfg)).toEqual([]);

    const broken = testSettings({ daylightFromHour: 99 } as never);
    expect(outOfRangeTunables(broken).join(" ")).toMatch(/GPA_DAYLIGHT_FROM_HOUR/);
  });

  it("keeps every tunable's default inside its own bounds", async () => {
    // Guards the whole table at once, so a future edit cannot reintroduce the problem.
    expect(outOfRangeTunables(testSettings())).toEqual([]);
  });

  it("exposes every Level 2 control as editable", async () => {
    const keys = TUNABLES.map((t) => t.key);
    for (const key of ["coOnPpm", "coOffPpm", "zonePollGameS", "maintMaxAgeS", "lightsFollowDaylight"]) {
      expect(keys).toContain(key);
    }
  });
});

describe("the tick is what turns a fan on", () => {
  /**
   * The behaviour in one test: the tick reads CO from the simulator and, when a zone is
   * above the threshold, switches that zone's fans - with no webhook involved at all.
   */
  function simWithZones(co: number) {
    const sim = lvl2Sim();
    sim.zones = [
      { name: "ZONE1", gasCarbonMonoxideLevel: co, risk: co >= 50 ? "Mid" : "Safe" },
      { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" },
    ];
    return sim;
  }

  it("polls by default, so a threshold below Mid actually works", async () => {
    const { c } = await make({ sim: simWithZones(0) });
    expect(c.cfg.zonePollGameS).toBeGreaterThan(0);
  });

  it("turns the fan on from the tick when the index passes the threshold", async () => {
    const { c, sim, advance } = await make({ sim: simWithZones(0), cfg: { coOnPpm: 5, coOffPpm: 3, zonePollGameS: 1 } });
    await fireTimers(c);
    expect(sim.of("fan-on")).toHaveLength(0); // CO 0: nothing to do

    sim.zones[0].gasCarbonMonoxideLevel = 6; // index > 5
    advance(2);
    await fireTimers(c);
    expect(sim.of("fan-on").map((call) => call[1])).toEqual(["F1"]);
    expect(c.devices.get("fan:F1")!.on).toBe(true);
    expect(c.devices.get("fan:F2")!.on).toBe(false); // ZONE2 is still clean
  });

  it("turns it off again from the tick once the index drops below the stop threshold", async () => {
    const { c, sim, advance } = await make({ sim: simWithZones(6), cfg: { coOnPpm: 5, coOffPpm: 3, zonePollGameS: 1 } });
    await fireTimers(c);
    expect(c.devices.get("fan:F1")!.on).toBe(true);

    sim.zones[0].gasCarbonMonoxideLevel = 4; // between 3 and 5: hysteresis keeps it running
    advance(2);
    await fireTimers(c);
    expect(c.devices.get("fan:F1")!.on).toBe(true);

    sim.zones[0].gasCarbonMonoxideLevel = 2; // below the stop threshold
    advance(2);
    await fireTimers(c);
    expect(c.devices.get("fan:F1")!.on).toBe(false);
  });

  it("needs no webhook at all for any of it", async () => {
    const { c, sim } = await make({ sim: simWithZones(9), cfg: { coOnPpm: 5, coOffPpm: 3, zonePollGameS: 1 } });
    await fireTimers(c);
    const d = c.ventilationDiagnosis();
    expect(d.co_events_seen).toBe(0);    // no webhook was involved at all
    expect(d.zones_reporting).toBe(2);   // both zones read straight from the simulator
    expect(sim.of("fan-on")).toHaveLength(1);
  });
});
