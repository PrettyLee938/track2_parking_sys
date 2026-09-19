import path from "node:path";
import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
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

