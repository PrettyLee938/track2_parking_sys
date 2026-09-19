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

// ---------------------------------------------------------------------------
// game speed
// ---------------------------------------------------------------------------
describe("game speed", () => {
  const simSettings = (speed: number) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "gpa-sim-")), "settings.json");
    writeFileSync(file, "\uFEFF" + JSON.stringify({ TeamName: "T", GameSpeedMultiplier: speed })); // the sim writes a BOM
    return file;
  };
  const dueIn = (c: Controller, label: string) => c.timers.find((t) => t.label === label)!.due - Date.now() / 1000;

  /** Three completed stays at the given game speed (planned 2 game-min each). */
  async function learnSpeed(c: Controller, speed: number) {
    const t0 = Date.now() / 1000, realS = 120 / speed;
    for (let i = 0; i < 3; i++) {
      await c.handle({ ...carEv(`L${speed}${i}`, "S3", "CarIn", "09:00:00", "2"), _received_at: at(t0) });
      await c.handle({ ...carEv(`L${speed}${i}`, "S3", "CarOut", "09:02:00", "2"), _received_at: at(t0 + realS) });
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
    const { c, sim } = await make({ cfg: { gameSpeed: 0.5 } }); // slow game: 6 game-s = 12 real s
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    c.gates.get("gateA")!.openRequestedAt! -= 8; // 8 real s: too early to retry at half speed
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"]]);
    c.gates.get("gateA")!.openRequestedAt! -= 5; // 13 real s
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"], ["open", "gateA"]]);
  });

  it("takes the speed from, in order: configuration, learned stays, simulator settings, 1.0", async () => {
    expect((await make()).c.timeScaleInfo).toEqual({ value: 1, source: "default" });

    const { c } = await make({ cfg: { simSettingsFile: simSettings(1.7) } });
    expect(c.timeScaleInfo).toEqual({ value: 1.7, source: "simulator settings" });
    await learnSpeed(c, 2);
    expect(c.timeScaleInfo.source).toBe("learned");
    expect(c.timeScale).toBeCloseTo(2, 6);

    const fixed = (await make({ cfg: { gameSpeed: 3, simSettingsFile: simSettings(1.7) } })).c;
    await learnSpeed(fixed, 2);
    expect(fixed.timeScaleInfo).toEqual({ value: 3, source: "configured" });
  });

  it("relearns when the simulator is restarted at another speed", async () => {
    const file = simSettings(1.7);
    const { c } = await make({ cfg: { simSettingsFile: file } });
    await learnSpeed(c, 1.7);
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
