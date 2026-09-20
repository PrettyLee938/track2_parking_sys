import { describe, expect, it } from "vitest";
import { SimulatorCalendar, type SimulatorCalendarAnchor } from "../src/simulatorCalendar";

const processToken = "process-a";
const realAnchorMs = 1_800_000_000_000;

function anchor(overrides: Partial<SimulatorCalendarAnchor> = {}): SimulatorCalendarAnchor {
  return {
    simulatorTimeIso: "2026-09-20T12:00:00+08:00",
    realAnchorMs,
    calendarSecondsPerRealSecond: 1,
    dayStartMinute: 6 * 60,
    nightStartMinute: 20 * 60,
    processInstanceToken: processToken,
    ...overrides,
  };
}

function calendar(config: Partial<SimulatorCalendarAnchor> = {}, currentToken = processToken) {
  return new SimulatorCalendar(anchor(config), currentToken);
}

describe("manual simulator calendar", () => {
  it("returns a manual daytime result at the anchor and switches at night start", () => {
    const model = calendar();

    expect(model.at(realAnchorMs)).toMatchObject({
      status: "available",
      confidence: "manual",
      source: "administrator_anchor",
      simulatorTimeIso: "2026-09-20T12:00:00.000+08:00",
      minuteOfDay: 12 * 60,
      utcOffsetMinutes: 8 * 60,
    });
    expect(model.isNight(realAnchorMs)).toMatchObject({ status: "available", isNight: false });
    expect(model.isNight(realAnchorMs + 8 * 60 * 60_000)).toMatchObject({
      status: "available",
      minuteOfDay: 20 * 60,
      isNight: true,
    });
  });

  it("treats an overnight night interval as half-open at both configured boundaries", () => {
    const model = calendar({ simulatorTimeIso: "2026-09-20T23:59:00+08:00" });

    expect(model.isNight(realAnchorMs)).toMatchObject({ status: "available", isNight: true });
    expect(model.isNight(realAnchorMs + 6 * 60_000)).toMatchObject({ status: "available", isNight: true });
    expect(model.isNight(realAnchorMs + 6 * 60 * 60_000 + 60_000)).toMatchObject({ status: "available", isNight: false });
    expect(model.isNight(realAnchorMs + 20 * 60 * 60_000 + 60_000)).toMatchObject({ status: "available", isNight: true });
  });

  it("advances simulator calendar time at the explicitly calibrated rate", () => {
    const model = calendar({
      simulatorTimeIso: "2026-12-31T23:30:00-05:00",
      calendarSecondsPerRealSecond: 60,
    });

    const later = model.at(realAnchorMs + 60_000);
    expect(later).toMatchObject({
      status: "available",
      simulatorTimeIso: "2027-01-01T00:30:00.000-05:00",
    });
    if (later.status === "available") {
      expect(later.simulatorEpochMs - Date.parse("2026-12-31T23:30:00-05:00")).toBe(3_600_000);
    }
  });

  it.each([
    ["requires an anchor", null, processToken, "missing_anchor"],
    ["requires a numeric-offset ISO timestamp", anchor({ simulatorTimeIso: "2026-09-20T12:00:00Z" }), processToken, "invalid_simulator_time"],
    ["rejects a non-string timestamp", { ...anchor(), simulatorTimeIso: 123 } as unknown as SimulatorCalendarAnchor, processToken, "invalid_simulator_time"],
    ["rejects an impossible date", anchor({ simulatorTimeIso: "2026-02-29T12:00:00+08:00" }), processToken, "invalid_simulator_time"],
    ["rejects unknown negative-zero offset", anchor({ simulatorTimeIso: "2026-09-20T12:00:00-00:00" }), processToken, "invalid_simulator_time"],
    ["requires a real-time anchor", anchor({ realAnchorMs: undefined }), processToken, "missing_real_anchor"],
    ["rejects an invalid real-time anchor", anchor({ realAnchorMs: Number.NaN }), processToken, "invalid_real_anchor"],
    ["requires a positive rate", anchor({ calendarSecondsPerRealSecond: 0 }), processToken, "invalid_rate"],
    ["rejects a non-finite rate", anchor({ calendarSecondsPerRealSecond: Number.POSITIVE_INFINITY }), processToken, "invalid_rate"],
    ["requires a day start", anchor({ dayStartMinute: undefined }), processToken, "missing_day_start"],
    ["rejects out-of-range schedule minutes", anchor({ dayStartMinute: 1440 }), processToken, "invalid_day_start"],
    ["requires a night start", anchor({ nightStartMinute: undefined }), processToken, "missing_night_start"],
    ["rejects equal day/night boundaries", anchor({ nightStartMinute: 360 }), processToken, "same_day_night_boundaries"],
    ["requires a process token", anchor({ processInstanceToken: "" }), processToken, "missing_process_token"],
    ["requires the current process token", anchor(), undefined, "missing_process_token"],
  ] as const)("returns unavailable when it %s", (_name, config, token, reason) => {
    const model = new SimulatorCalendar(config, token);
    expect(model.at(realAnchorMs)).toEqual({ status: "unavailable", confidence: "none", reason });
    expect(model.isNight(realAnchorMs)).toEqual({ status: "unavailable", confidence: "none", reason });
  });

  it("invalidates an anchor captured by a previous server process", () => {
    const model = calendar({}, "process-after-restart");

    expect(model.at(realAnchorMs)).toEqual({
      status: "unavailable",
      confidence: "none",
      reason: "process_mismatch",
    });
  });

  it("rejects invalid evaluation times and overflow without falling back to machine time", () => {
    const model = calendar();
    expect(model.at(Number.NaN)).toMatchObject({ status: "unavailable", reason: "invalid_real_time" });

    const overflowing = calendar({
      calendarSecondsPerRealSecond: Number.MAX_VALUE,
      realAnchorMs: -Number.MAX_VALUE,
    });
    expect(overflowing.at(Number.MAX_VALUE)).toMatchObject({
      status: "unavailable",
      reason: "calendar_time_out_of_range",
    });
  });
});
