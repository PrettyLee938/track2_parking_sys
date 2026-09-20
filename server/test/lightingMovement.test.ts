import { describe, expect, it } from "vitest";
import { countZoneMovements } from "../src/lightingMovement";

const base = {
  zones: ["A", "B"],
  entryLanes: { EntryA: { zone: "A", current: null as string | null }, EntryB: { zone: "B", current: null as string | null } },
  exitLanes: { ExitA: { zone: "A" }, ExitB: { zone: "B" } },
  spotZones: { ParkA: "A", ParkB: "B" },
};

describe("countZoneMovements", () => {
  it("counts concurrent inbound and outbound movements independently by zone", () => {
    const result = countZoneMovements({ ...base, cars: [
      { plate: "A1", status: "dispatched", entry_lane: "EntryA", exit_lane: null, spot: "ParkA" },
      { plate: "B1", status: "to_exit", entry_lane: "EntryB", exit_lane: "ExitB", spot: "ParkB" },
      { plate: "A2", status: "parked", entry_lane: "EntryA", exit_lane: null, spot: "ParkA" },
    ] });
    expect(result).toEqual({ A: { movingVehicles: 1, known: true }, B: { movingVehicles: 1, known: true } });
  });

  it("treats queueing and stationary payment as non-movement", () => {
    const result = countZoneMovements({ ...base, cars: [
      { plate: "A1", status: "queued", entry_lane: "EntryA", exit_lane: null, spot: null },
      { plate: "B1", status: "invoiced", entry_lane: "EntryB", exit_lane: "ExitB", spot: "ParkB" },
    ] });
    expect(result).toEqual({ A: { movingVehicles: 0, known: true }, B: { movingVehicles: 0, known: true } });
  });

  it("marks zones with unknown visits or orphaned lane owners as uncertain", () => {
    const result = countZoneMovements({
      ...base,
      entryLanes: { ...base.entryLanes, EntryA: { zone: "A", current: "MISSING" } },
      cars: [{ plate: "A1", status: "unknown", entry_lane: "EntryB", exit_lane: null, spot: "ParkB" }],
    });
    expect(result.A.known).toBe(false);
    expect(result.B.known).toBe(false);
  });

  it("suppresses all zones when a moving vehicle has no reliable zone mapping", () => {
    const result = countZoneMovements({ ...base, cars: [
      { plate: "X", status: "released", entry_lane: null, exit_lane: "missing", spot: null },
    ] });
    expect(result.A.known).toBe(false);
    expect(result.B.known).toBe(false);
  });
});
