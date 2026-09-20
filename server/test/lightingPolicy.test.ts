import { describe, expect, it } from "vitest";
import { planZoneLighting, type LightingCalendarState, type LightingZoneState } from "../src/lightingPolicy";

const zone = (overrides: Partial<LightingZoneState> = {}): LightingZoneState => ({
  zone: "ZoneA",
  movingVehicles: 1,
  movementKnown: true,
  inventoryComplete: true,
  lights: [{ name: "Light1", isOn: false, operable: true }],
  ...overrides,
});

describe("planZoneLighting", () => {
  it("fails closed when the manual simulator calendar is unavailable", () => {
    const result = planZoneLighting({ status: "unavailable", reason: "process_mismatch" }, zone());
    expect(result).toMatchObject({ status: "unavailable", desiredOn: null, commands: [] });
    expect(result.reason).toContain("process_mismatch");
  });

  it("turns lights on only for movement during simulator nighttime", () => {
    const calendar: LightingCalendarState = { status: "available", isNight: true };
    const result = planZoneLighting(calendar, zone());
    expect(result).toMatchObject({ status: "ready", desiredOn: true, commands: [{ light: "Light1", action: "on" }] });
  });

  it("turns lights off in daytime and when no vehicles are moving", () => {
    expect(planZoneLighting({ status: "available", isNight: false }, zone()).commands).toEqual([]);
    expect(planZoneLighting({ status: "available", isNight: true }, zone({ movingVehicles: 0, lights: [
      { name: "Light1", isOn: true, operable: true },
    ] })).commands).toEqual([{ light: "Light1", action: "off" }]);
  });

  it("does not issue zone commands if movement or the inventory is uncertain", () => {
    const calendar: LightingCalendarState = { status: "available", isNight: true };
    expect(planZoneLighting(calendar, zone({ movementKnown: false })).commands).toEqual([]);
    expect(planZoneLighting(calendar, zone({ inventoryComplete: false })).commands).toEqual([]);
  });

  it("avoids redundant commands and skips broken, maintained, or unknown lights", () => {
    const result = planZoneLighting({ status: "available", isNight: true }, zone({ lights: [
      { name: "AlreadyOn", isOn: true, operable: true },
      { name: "Broken", isOn: false, operable: false },
      { name: "Unknown", isOn: false, operable: null },
      { name: "NeedsOn", isOn: false, operable: true },
    ] }));
    expect(result.commands).toEqual([{ light: "NeedsOn", action: "on" }]);
    expect(result.skippedLights.map(({ light }) => light)).toEqual(["Broken", "Unknown"]);
  });
});
