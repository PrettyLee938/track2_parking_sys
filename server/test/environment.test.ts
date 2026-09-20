import { describe, expect, it } from "vitest";
import { EventClass } from "@gpa/shared";
import { parseCarbonMonoxideEvent, parseExhaustFans, parseLights, parseZones } from "../src/environment";

describe("Level 2 simulator environment normalization", () => {
  it("normalizes PascalCase light rows from the supplied Level 2 shape", () => {
    const source = {
      Name: "t_0", ZoneParent: "ZONE1", LightType: "Spot", Group: "G1",
      X: 1870, Y: 1018, Rotation: 0, Scale: 0.27, Intensity: 0.5, IsOn: true,
      colorR: 255, colorG: 255, colorB: 255,
    };
    const result = parseLights({ Data: { Items: [source] } });

    expect(result.shape).toBe("wrapped-array");
    expect(result.raw).toEqual({ Data: { Items: [source] } });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      name: { available: true, value: "t_0", sourceKeys: ["Name"] },
      zoneParent: { available: true, value: "ZONE1" },
      isOn: { available: true, value: true },
      intensity: { available: true, value: 0.5 },
      usageCounter: { available: false, value: null, reason: "missing" },
      raw: source,
    });
  });

  it("accepts casing/punctuation variants for known fan fields without equating repair and failure", () => {
    const source = {
      name: "fan0", zone_parent: "ZONE2", fume_intensity: "0.3", is_on: "false",
      is_repair_requested: true, repair_progress: "0", usage_counter: 12,
    };
    const result = parseExhaustFans({ exhaustFans: [source] });
    expect(result.rows[0]).toMatchObject({
      name: { available: true, value: "fan0" },
      zoneParent: { available: true, value: "ZONE2" },
      fumeIntensity: { available: true, value: 0.3 },
      isOn: { available: true, value: false },
      isRepairRequested: { available: true, value: true },
      repairProgress: { available: true, value: 0 },
      usageCounter: { available: true, value: 12 },
      broken: { available: false, value: null, reason: "missing" },
    });
  });

  it("normalizes known zone geometry and leaves absent environment readings unavailable", () => {
    const source = { Name: "ZONE1", ZoneType: "Closed", X: 1502.5, Y: 1120, Width: 2223, Height: 1272 };
    const result = parseZones({ zones: [source] });
    expect(result.rows[0]).toMatchObject({
      name: { available: true, value: "ZONE1" },
      zoneType: { available: true, value: "Closed" },
      width: { available: true, value: 2223 },
      carbonMonoxideLevel: { available: false, value: null, reason: "missing" },
      dangerLevel: { available: false, value: null, reason: "missing" },
    });
  });

  it("normalizes the documented CO webhook fields and preserves the raw event", () => {
    const event = {
      EventClass: EventClass.CarbonMonoxide, EventId: "e-1", SequenceId: "42",
      ServerDateTime: "2026-09-20 12:00:00", ZoneName: "ZONE2",
      CarbonMonoxideLevel: "56", DangerLevel: "High", Signature: "opaque",
    };
    const parsed = parseCarbonMonoxideEvent(event);
    expect(parsed).toMatchObject({
      isCarbonMonoxideEvent: true,
      zoneName: { available: true, value: "ZONE2" },
      carbonMonoxideLevel: { available: true, value: 56, sourceKeys: ["CarbonMonoxideLevel"] },
      dangerLevel: { available: true, value: "High" },
      raw: event,
    });
  });

  it("supports casing variants but does not guess CO aliases or accept an unrelated event class", () => {
    const event = {
      event_class: "other_event", zone_name: "ZONE1", carbon_monoxide_level: "not-a-number", co: 20,
    };
    const parsed = parseCarbonMonoxideEvent(event);
    expect(parsed.isCarbonMonoxideEvent).toBe(false);
    expect(parsed.zoneName).toMatchObject({ available: true, value: "ZONE1" });
    expect(parsed.carbonMonoxideLevel).toMatchObject({ available: false, value: null, reason: "invalid" });
    expect(parsed.dangerLevel).toMatchObject({ available: false, value: null, reason: "missing" });
  });

  it("reports ambiguous duplicate keys and unknown list shapes instead of silently selecting/defaulting", () => {
    const duplicate = parseLights([{ Name: "one", name: "two", IsOn: "maybe" }]);
    expect(duplicate.rows[0].name).toMatchObject({ available: false, value: null, reason: "ambiguous" });
    expect(duplicate.rows[0].isOn).toMatchObject({ available: false, value: null, reason: "invalid" });

    const unknown = { success: true, payload: [{ Name: "unrecognized wrapper" }] };
    const result = parseZones(unknown);
    expect(result.shape).toBe("unknown");
    expect(result.rows).toEqual([]);
    expect(result.raw).toBe(unknown);
    expect(result.issues).toHaveLength(1);
  });
});
