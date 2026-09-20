/**
 * A manually anchored simulator calendar.
 *
 * The simulator contract does not expose a calendar clock. This model therefore uses
 * only an administrator-supplied calendar timestamp, its explicitly captured real-time
 * anchor, and a calibrated calendar-seconds-per-real-second rate. The UTC offset is
 * fixed for this anchor; re-anchor if the operator changes the modeled offset or date.
 *
 * This module deliberately does not read Date.now(), GameClock, settings.json, or
 * machine-local time. Callers must pass the real timestamp being evaluated to at().
 */

export interface SimulatorCalendarAnchor {
  /** Simulator calendar time manually observed/set by an administrator, with ±HH:MM offset. */
  simulatorTimeIso: string;
  /** Same-process monotonic milliseconds when simulatorTimeIso was observed/set. */
  realAnchorMs: number;
  /** Calibrated simulator-calendar seconds advanced per real second. */
  calendarSecondsPerRealSecond: number;
  /** Local minute (0..1439) at which daytime begins. */
  dayStartMinute: number;
  /** Local minute (0..1439) at which nighttime begins. */
  nightStartMinute: number;
  /** Process token persisted with this anchor. */
  processInstanceToken: string;
}

export type SimulatorCalendarUnavailableReason =
  | "missing_anchor"
  | "missing_simulator_time"
  | "invalid_simulator_time"
  | "missing_real_anchor"
  | "invalid_real_anchor"
  | "missing_rate"
  | "invalid_rate"
  | "missing_day_start"
  | "invalid_day_start"
  | "missing_night_start"
  | "invalid_night_start"
  | "same_day_night_boundaries"
  | "missing_process_token"
  | "process_mismatch"
  | "manual_invalidation"
  | "invalid_real_time"
  | "calendar_time_out_of_range";

export interface SimulatorCalendarUnavailable {
  status: "unavailable";
  confidence: "none";
  reason: SimulatorCalendarUnavailableReason;
}

export interface SimulatorCalendarAtResult {
  status: "available";
  confidence: "manual";
  source: "administrator_anchor";
  /** Current modeled simulator-calendar timestamp, formatted with the anchor's UTC offset. */
  simulatorTimeIso: string;
  /** Current modeled simulator instant on the UTC timeline. */
  simulatorEpochMs: number;
  /** Local minute of day in the anchor's fixed numeric UTC offset. */
  minuteOfDay: number;
  utcOffsetMinutes: number;
  dayStartMinute: number;
  nightStartMinute: number;
  calendarSecondsPerRealSecond: number;
}

export type SimulatorCalendarAt = SimulatorCalendarAtResult | SimulatorCalendarUnavailable;

export type SimulatorCalendarNight =
  | (SimulatorCalendarAtResult & { isNight: boolean })
  | SimulatorCalendarUnavailable;

export type PersistedSimulatorCalendarRecord =
  | (SimulatorCalendarAnchor & {
      action: "anchor";
      runId: string;
      reason: string;
      recordedAt: string;
    })
  | {
      action: "invalidate";
      runId: string | null;
      reason: string;
      recordedAt: string;
    };

export type SimulatorCalendarProviderAt =
  | (SimulatorCalendarAtResult & { runId: string })
  | (SimulatorCalendarUnavailable & { runId: string | null });

export type SimulatorCalendarProviderNight =
  | (SimulatorCalendarAtResult & { isNight: boolean; runId: string })
  | (SimulatorCalendarUnavailable & { runId: string | null });

export type SimulatorCalendarStatus =
  | {
      status: "available";
      confidence: "manual";
      reason: null;
      run_id: string;
      modeled_time: string;
      simulator_epoch_ms: number;
      is_night: boolean;
      minute_of_day: number;
      day_start_minute: number;
      night_start_minute: number;
      calendar_seconds_per_real_second: number;
      source: "administrator_anchor";
      anchored_at: string;
    }
  | {
      status: "unavailable";
      confidence: "none";
      reason: SimulatorCalendarUnavailableReason;
      run_id: string | null;
      modeled_time: null;
      simulator_epoch_ms: null;
      is_night: null;
      day_start_minute: null;
      night_start_minute: null;
      calendar_seconds_per_real_second: null;
      source: null;
      anchored_at: string | null;
    };

interface ParsedTimestamp {
  epochMs: number;
  utcOffsetMinutes: number;
}

const ISO_TIMESTAMP_WITH_NUMERIC_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([+-])(\d{2}):(\d{2})$/;

function parseTimestamp(value: string): ParsedTimestamp | null {
  const match = ISO_TIMESTAMP_WITH_NUMERIC_OFFSET.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0") || 0);
  const offsetHour = Number(match[9]);
  const offsetMinute = Number(match[10]);

  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;

  const sign = match[8] === "+" ? 1 : -1;
  const utcOffsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  // RFC 3339 uses -00:00 to mean that the local offset is unknown, not that it is UTC.
  if (match[8] === "-" && offsetHour === 0 && offsetMinute === 0) return null;

  const localAsUtc = new Date(0);
  localAsUtc.setUTCFullYear(year, month - 1, day);
  localAsUtc.setUTCHours(hour, minute, second, millisecond);
  const epochMs = localAsUtc.getTime() - utcOffsetMinutes * 60_000;
  return Number.isFinite(epochMs) ? { epochMs, utcOffsetMinutes } : null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function minuteValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1440;
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function formatLocalTimestamp(epochMs: number, offsetMinutes: number): string | null {
  const localAsUtc = new Date(Math.trunc(epochMs + offsetMinutes * 60_000));
  if (!Number.isFinite(localAsUtc.getTime())) return null;
  const iso = localAsUtc.toISOString();
  // This model accepts four-digit anchor years; do not emit a malformed truncated
  // timestamp if progression goes beyond that representable calendar range.
  if (!/^\d{4}-/.test(iso)) return null;
  return `${iso.slice(0, 23)}${formatOffset(offsetMinutes)}`;
}

/**
 * Pure calendar projection. A mismatched process token invalidates the old anchor,
 * requiring an administrator to anchor the simulator calendar again after restart.
 */
export class SimulatorCalendar {
  private readonly unavailableReason: SimulatorCalendarUnavailableReason | null;
  private readonly anchor: ParsedTimestamp | null;
  private readonly realAnchorMs: number | null;
  private readonly rate: number | null;
  private readonly dayStartMinute: number | null;
  private readonly nightStartMinute: number | null;

  constructor(
    config: Partial<SimulatorCalendarAnchor> | null | undefined,
    currentProcessInstanceToken: string | null | undefined,
  ) {
    let reason: SimulatorCalendarUnavailableReason | null = null;
    let anchor: ParsedTimestamp | null = null;
    let realAnchorMs: number | null = null;
    let rate: number | null = null;
    let dayStartMinute: number | null = null;
    let nightStartMinute: number | null = null;

    if (!config) reason = "missing_anchor";
    else if (config.simulatorTimeIso === undefined || config.simulatorTimeIso === null ||
      (typeof config.simulatorTimeIso === "string" && config.simulatorTimeIso.trim() === "")) {
      reason = "missing_simulator_time";
    } else if (typeof config.simulatorTimeIso !== "string") {
      reason = "invalid_simulator_time";
    } else {
      anchor = parseTimestamp(config.simulatorTimeIso);
      if (!anchor) reason = "invalid_simulator_time";
    }

    if (!reason && config) {
      if (config.realAnchorMs === undefined) reason = "missing_real_anchor";
      else if (typeof config.realAnchorMs !== "number" || !Number.isFinite(config.realAnchorMs)) reason = "invalid_real_anchor";
      else realAnchorMs = config.realAnchorMs;
    }

    if (!reason && config) {
      if (config.calendarSecondsPerRealSecond === undefined) reason = "missing_rate";
      else if (typeof config.calendarSecondsPerRealSecond !== "number" ||
        !Number.isFinite(config.calendarSecondsPerRealSecond) || config.calendarSecondsPerRealSecond <= 0) reason = "invalid_rate";
      else rate = config.calendarSecondsPerRealSecond;
    }

    if (!reason && config) {
      if (config.dayStartMinute === undefined) reason = "missing_day_start";
      else if (!minuteValue(config.dayStartMinute)) reason = "invalid_day_start";
      else dayStartMinute = config.dayStartMinute;
    }

    if (!reason && config) {
      if (config.nightStartMinute === undefined) reason = "missing_night_start";
      else if (!minuteValue(config.nightStartMinute)) reason = "invalid_night_start";
      else nightStartMinute = config.nightStartMinute;
      if (!reason && dayStartMinute === nightStartMinute) reason = "same_day_night_boundaries";
    }

    if (!reason && config) {
      const anchorToken = config.processInstanceToken;
      if (typeof anchorToken !== "string" || anchorToken.trim() === "" ||
        typeof currentProcessInstanceToken !== "string" || currentProcessInstanceToken.trim() === "") {
        reason = "missing_process_token";
      } else if (anchorToken !== currentProcessInstanceToken) {
        reason = "process_mismatch";
      }
    }

    this.unavailableReason = reason;
    this.anchor = reason ? null : anchor;
    this.realAnchorMs = reason ? null : realAnchorMs;
    this.rate = reason ? null : rate;
    this.dayStartMinute = reason ? null : dayStartMinute;
    this.nightStartMinute = reason ? null : nightStartMinute;
  }

  at(realMs: number): SimulatorCalendarAt {
    if (this.unavailableReason) return this.unavailable(this.unavailableReason);
    if (!Number.isFinite(realMs)) return this.unavailable("invalid_real_time");

    const epochMs = this.anchor!.epochMs + (realMs - this.realAnchorMs!) * this.rate!;
    if (!Number.isFinite(epochMs)) return this.unavailable("calendar_time_out_of_range");

    const offsetMinutes = this.anchor!.utcOffsetMinutes;
    const localMs = epochMs + offsetMinutes * 60_000;
    const localDate = new Date(Math.trunc(localMs));
    const simulatorTimeIso = formatLocalTimestamp(epochMs, offsetMinutes);
    if (!Number.isFinite(localDate.getTime()) || !simulatorTimeIso) {
      return this.unavailable("calendar_time_out_of_range");
    }

    return {
      status: "available",
      confidence: "manual",
      source: "administrator_anchor",
      simulatorTimeIso,
      simulatorEpochMs: epochMs,
      minuteOfDay: localDate.getUTCHours() * 60 + localDate.getUTCMinutes(),
      utcOffsetMinutes: offsetMinutes,
      dayStartMinute: this.dayStartMinute!,
      nightStartMinute: this.nightStartMinute!,
      calendarSecondsPerRealSecond: this.rate!,
    };
  }

  isNight(realMs: number): SimulatorCalendarNight {
    const current = this.at(realMs);
    if (current.status === "unavailable") return current;

    // Daytime is the half-open clockwise interval [day start, night start); the
    // complement is night. This works whether the configured day interval crosses
    // midnight or not, and makes exact transition minutes deterministic.
    const isDay = this.dayStartMinute! < this.nightStartMinute!
      ? current.minuteOfDay >= this.dayStartMinute! && current.minuteOfDay < this.nightStartMinute!
      : current.minuteOfDay >= this.dayStartMinute! || current.minuteOfDay < this.nightStartMinute!;

    return { ...current, isNight: !isDay };
  }

  private unavailable(reason: SimulatorCalendarUnavailableReason): SimulatorCalendarUnavailable {
    return { status: "unavailable", confidence: "none", reason };
  }
}

/**
 * Reads the latest durable record on each call so an invalidation takes effect
 * immediately. It uses an elapsed monotonic clock (never wall time-of-day) and
 * fails closed if a persisted anchor came from a previous process instance.
 */
export class PersistedSimulatorCalendar {
  constructor(
    private readonly latestRecord: () => PersistedSimulatorCalendarRecord | null,
    readonly processInstanceToken: string,
    private readonly realNow: () => number = () => performance.now(),
  ) {}

  at(realMs = this.realNow()): SimulatorCalendarProviderAt {
    const record = this.latestRecord();
    if (!record) return { status: "unavailable", confidence: "none", reason: "missing_anchor", runId: null };
    if (record.action === "invalidate") {
      return { status: "unavailable", confidence: "none", reason: "manual_invalidation", runId: record.runId };
    }
    const calendar = new SimulatorCalendar(record, this.processInstanceToken);
    const result = calendar.at(realMs);
    return { ...result, runId: record.runId };
  }

  isNight(realMs = this.realNow()): SimulatorCalendarProviderNight {
    const current = this.at(realMs);
    if (current.status === "unavailable") return current;
    const isDay = current.dayStartMinute < current.nightStartMinute
      ? current.minuteOfDay >= current.dayStartMinute && current.minuteOfDay < current.nightStartMinute
      : current.minuteOfDay >= current.dayStartMinute || current.minuteOfDay < current.nightStartMinute;
    return { ...current, isNight: !isDay };
  }

  status(realMs = this.realNow()): SimulatorCalendarStatus {
    const record = this.latestRecord();
    const modeled = this.isNight(realMs);
    if (modeled.status === "unavailable") {
      return {
        status: "unavailable", confidence: "none", reason: modeled.reason, run_id: modeled.runId,
        modeled_time: null, simulator_epoch_ms: null, is_night: null, day_start_minute: null,
        night_start_minute: null, calendar_seconds_per_real_second: null, source: null,
        anchored_at: record?.action === "anchor" ? record.recordedAt : null,
      };
    }
    return {
      status: "available", confidence: "manual", reason: null, run_id: modeled.runId,
      modeled_time: modeled.simulatorTimeIso, simulator_epoch_ms: modeled.simulatorEpochMs,
      is_night: modeled.isNight, minute_of_day: modeled.minuteOfDay,
      day_start_minute: modeled.dayStartMinute, night_start_minute: modeled.nightStartMinute,
      calendar_seconds_per_real_second: modeled.calendarSecondsPerRealSecond,
      source: "administrator_anchor", anchored_at: record?.recordedAt ?? "",
    };
  }
}
