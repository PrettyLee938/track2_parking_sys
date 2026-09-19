/**
 * Where the lights are: sorting a zone's lights into the middle aisle and the parking rows.
 * `list-lights` gives only name/group/zone/isOn, so lighting just the part of a zone a car
 * is using comes from the level file's coordinates.
 */
import { describe, expect, it } from "vitest";
import { lightsFromLevel, nearestLight } from "../src/topology";

/** A zone laid out like Level 2's: two rows of bays with one aisle between them. */
function zone(name: string, top: number, height = 170, gap = 500) {
  const bottom = top + height + gap;
  return {
    spots: [
      { Name: `${name}-a`, Purpose: "Park", ZoneParent: name, X: 700, Y: top, Height: height },
      { Name: `${name}-b`, Purpose: "Park", ZoneParent: name, X: 1500, Y: top, Height: height },
      { Name: `${name}-c`, Purpose: "Park", ZoneParent: name, X: 700, Y: bottom, Height: height },
      { Name: `${name}-d`, Purpose: "Park", ZoneParent: name, X: 1500, Y: bottom, Height: height },
    ],
    lights: [
      { Name: `${name}-wall-top`, ZoneParent: name, Group: "G", X: 740, Y: top + 10 },
      { Name: `${name}-aisle-w`, ZoneParent: name, Group: "G", X: 1100, Y: top + height + gap / 2 },
      { Name: `${name}-aisle-e`, ZoneParent: name, Group: "G", X: 1870, Y: top + height + gap / 2 },
      { Name: `${name}-wall-bottom`, ZoneParent: name, Group: "G", X: 740, Y: bottom + height - 10 },
    ],
  };
}

describe("light placement", () => {
  it("calls the lights between the two rows of bays the middle road", () => {
    const z = zone("ZONE1", 714);
    const placed = lightsFromLevel({ Lights: z.lights, ParkingSpots: z.spots });
    const role = (n: string) => placed.get(n)!.role;
    expect(role("ZONE1-aisle-w")).toBe("road");
    expect(role("ZONE1-aisle-e")).toBe("road");
    expect(role("ZONE1-wall-top")).toBe("bay");
    expect(role("ZONE1-wall-bottom")).toBe("bay");
  });

  it("keeps zones apart, so one zone's rows never classify another's lights", () => {
    const a = zone("ZONE1", 714), b = zone("ZONE2", 2208);
    const placed = lightsFromLevel({ Lights: [...a.lights, ...b.lights], ParkingSpots: [...a.spots, ...b.spots] });
    expect(placed.get("ZONE2-aisle-w")!.role).toBe("road");
    expect(placed.get("ZONE2-wall-top")!.role).toBe("bay");
    expect(placed.get("ZONE1-aisle-w")!.zone).toBe("ZONE1");
  });

  it("marks every light a bay when a zone has no aisle to find", () => {
    // One row only: there is no "between the rows", so nothing is a road light and the
    // caller falls back to lighting the whole zone.
    const spots = [{ Name: "S1", Purpose: "Park", ZoneParent: "Z", X: 700, Y: 100, Height: 170 }];
    const lights = [{ Name: "l1", ZoneParent: "Z", Group: "G", X: 700, Y: 400 }];
    const placed = lightsFromLevel({ Lights: lights, ParkingSpots: spots });
    expect(placed.get("l1")!.role).toBe("bay");
  });

  it("ignores entry and exit sensors when finding the rows", () => {
    const z = zone("ZONE1", 714);
    const withSensors = [...z.spots, { Name: "ENTRY1", Purpose: "EntrySpot", ZoneParent: "ZONE1", X: 100, Y: 1100, Height: 0 }];
    const placed = lightsFromLevel({ Lights: z.lights, ParkingSpots: withSensors });
    expect(placed.get("ZONE1-aisle-w")!.role).toBe("road");
  });

  it("finds the bay light over a given spot's own row", () => {
    const z = zone("ZONE1", 714);
    const placed = [...lightsFromLevel({ Lights: z.lights, ParkingSpots: z.spots }).values()];
    const topRow = nearestLight(placed, { x: 700, y: 714 }, "bay");
    const bottomRow = nearestLight(placed, { x: 700, y: 1384 }, "bay");
    expect(topRow!.name).toBe("ZONE1-wall-top");
    expect(bottomRow!.name).toBe("ZONE1-wall-bottom");
    // Asking for a road light never returns a bay one.
    expect(nearestLight(placed, { x: 700, y: 714 }, "road")!.role).toBe("road");
  });

  it("returns null when there is nothing of that role", () => {
    expect(nearestLight([], { x: 0, y: 0 })).toBe(null);
  });
});
