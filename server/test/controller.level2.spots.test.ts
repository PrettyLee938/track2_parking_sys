import { describe, expect, it } from "vitest";
import { CarType, ComponentType, EventClass } from "@gpa/shared";
import { carEv, FakeSim, feed, gateEv, make } from "./helpers";

const component = (type: string, name: string, id: string) => ({
  EventClass: EventClass.ComponentBroken,
  Type: type,
  Name: name,
  EventId: id,
  _received_at: new Date().toISOString(),
});

describe("Level 2 parking spot failures", () => {
  it("does not allocate a broken spot", async () => {
    const sim = FakeSim.lvl1(2);
    sim.spots.find((s) => s.name === "S1")!.broken = true;
    const { c } = await make({ sim });

    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00", "2", CarType.Normal));

    expect(c.spots.get("S1")!.broken).toBe(true);
    expect(c.cars.get("A")!.spot).toBe("S2");
  });

  it("reroutes an in-flight car when its reserved spot breaks", async () => {
    const sim = FakeSim.lvl1(2);
    const { c } = await make({ sim });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.last()).toEqual(["goto", "A", "S1"]);

    await c.handle(component(ComponentType.ParkingSpot, "S1", "broken-1"));

    expect(sim.gotos().at(-1)).toEqual(["goto", "A", "S2"]);
    expect(c.spots.get("S1")!.reserved_for).toBeNull();
    expect(c.spots.get("S2")!.reserved_for).toBe("A");
    expect(c.feed.some((item) => item.msg.includes("rerouting to S2"))).toBe(true);
  });

  it("sends the car out when a broken spot has no compatible replacement", async () => {
    const sim = FakeSim.lvl1(1);
    const { c } = await make({ sim });
    await feed(c, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"));

    await c.handle(component(ComponentType.ParkingSpot, "S1", "broken-2"));

    expect(sim.gotos().at(-1)).toEqual(["goto", "A", "leavepark"]);
    expect(c.cars.get("A")?.status).toBe("turned_away");
    expect(c.entryLanes.get("ENTRY1")?.current).toBe("A");

    await feed(c, carEv("A", "ENTRY1", "CarOut", "10:00:02"));
    expect(c.entryLanes.get("ENTRY1")?.current).toBeNull();
    expect(c.cars.has("A")).toBe(false);
  });
});
