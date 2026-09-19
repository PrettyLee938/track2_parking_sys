/**
 * The component layer (Level 2): everything that wears out, breaks, or has to be
 * switched on and off - gates, parking spots, lights and exhaust fans.
 *
 * Three jobs the brief asks for, which are really one:
 *
 *   - usage cycles, because preventive maintenance needs to know what is worn;
 *   - preventive maintenance, which repairs a component before overuse breaks it;
 *   - CO monitoring driving the exhaust fans, and daylight driving the lights.
 *
 * Gates and spots keep their own classes in controller.ts (they carry car-flow state
 * the controller reads everywhere). Rather than refactor those into a hierarchy, wear
 * is tracked here in a parallel book keyed by component name, and lights and fans -
 * which the controller does not model at all - get a small Device record. That keeps
 * a large, well-tested controller untouched while giving all four kinds one registry
 * for the dashboard, the maintenance scheduler and the daily report to read.
 *
 * Every duration here is GAME seconds, like every other timer in this codebase: the
 * simulator's speed changes mid-run, and wear accrues in the simulator's time, not ours.
 */
import { normaliseDevice, CO_DANGER_WORDS, type SimDevice } from "@gpa/shared";

export type ComponentKind = "gate" | "spot" | "light" | "fan";

export const COMPONENT_KINDS: ComponentKind[] = ["gate", "spot", "light", "fan"];

/** A light or exhaust fan: the two component kinds the controller does not otherwise model. */
export class Device {
  on = false;
  broken = false;
  maintenance = false;
  /** Set while we have sent a command the simulator has not confirmed. */
  pending: "on" | "off" | null = null;
  /**
   * An operator override. While set, the ventilation and daylight loops leave this device
   * alone - the same contract gates have, so a manual decision is not undone a second later
   * by automation. "auto" clears it.
   */
  hold: "on" | "off" | null = null;

  constructor(readonly kind: "light" | "fan", readonly name: string, public zone: string) {}

  get operable(): boolean {
    return !this.broken && !this.maintenance;
  }

  /** Whether the automatic loops may switch this device right now. */
  get automatic(): boolean {
    return this.hold === null;
  }
}

/** Accumulated wear for one component, persisted so a restart does not reset it. */
export interface Wear {
  kind: ComponentKind;
  name: string;
  zone: string;
  /** Open/close for a gate, park for a spot, on/off for a light or fan. */
  cycles: number;
  /** Accumulated on-time, in game seconds (lights and fans). */
  runtime_game_s: number;
  /** Times the simulator reported this component broken. */
  breakdowns: number;
  /** Repairs we sent, preventive or reactive. */
  repairs: number;
  /** Cycles at the last repair: wear since then is cycles - cycles_at_repair. */
  cycles_at_repair: number;
  runtime_at_repair: number;
  last_repair_at: string | null;
  last_broken_at: string | null;
  /** When we first saw this component, so age is measurable before any repair. */
  first_seen_at: string | null;
}

const newWear = (kind: ComponentKind, name: string, zone: string): Wear => ({
  kind, name, zone, cycles: 0, runtime_game_s: 0, breakdowns: 0, repairs: 0,
  cycles_at_repair: 0, runtime_at_repair: 0, last_repair_at: null, last_broken_at: null,
  first_seen_at: new Date().toISOString(),
});

/** What a component has accumulated since its last repair - what maintenance acts on. */
export function wearSinceRepair(w: Wear): { cycles: number; runtime_game_s: number } {
  return {
    cycles: Math.max(0, w.cycles - w.cycles_at_repair),
    runtime_game_s: Math.max(0, w.runtime_game_s - w.runtime_at_repair),
  };
}

export interface WearThresholds {
  /**
   * Seconds since the last repair before a component is due, regardless of usage.
   * The simulator breaks things by usage, not age, so this is a scheduling and testing
   * aid rather than a model of the simulator. 0 disables.
   */
  maxAgeS?: number;
  /** Gate open/close cycles since last repair before it is due. 0 disables. */
  gateCycles: number;
  /** Cars parked in a spot since last repair before it is due. 0 disables. */
  spotCycles: number;
  /** On-time in game seconds for a light or fan before it is due. 0 disables. */
  deviceRuntimeGameS: number;
  /** On/off cycles for a light or fan before it is due. 0 disables. */
  deviceCycles: number;
}

/** Seconds since this component was last repaired, or since we first saw it. */
export function ageSinceService(w: Wear, now = Date.now()): number {
  const from = Date.parse(w.last_repair_at ?? w.first_seen_at ?? "");
  return Number.isNaN(from) ? 0 : Math.max(0, (now - from) / 1000);
}

/** How worn a component is, as a fraction of its threshold (1 = due, >1 = overdue). */
export function wearRatio(w: Wear, t: WearThresholds, now = Date.now()): number {
  const since = wearSinceRepair(w);
  const limits: number[] = [];
  if (t.maxAgeS && t.maxAgeS > 0) limits.push(ageSinceService(w, now) / t.maxAgeS);
  if (w.kind === "gate" && t.gateCycles > 0) limits.push(since.cycles / t.gateCycles);
  if (w.kind === "spot" && t.spotCycles > 0) limits.push(since.cycles / t.spotCycles);
  if (w.kind === "light" || w.kind === "fan") {
    if (t.deviceRuntimeGameS > 0) limits.push(since.runtime_game_s / t.deviceRuntimeGameS);
    if (t.deviceCycles > 0) limits.push(since.cycles / t.deviceCycles);
  }
  return limits.length ? Math.max(...limits) : 0;
}

/**
 * Usage cycles for every component, and the arithmetic preventive maintenance reads.
 * Counting happens here; deciding what to repair, and actually repairing it, is the
 * controller's job (only it knows whether a component is busy).
 */
export class WearBook {
  private readonly book = new Map<string, Wear>();

  private key(kind: ComponentKind, name: string) {
    return `${kind}:${name}`;
  }

  /** The record for a component, created on first sight. */
  get(kind: ComponentKind, name: string, zone = ""): Wear {
    const k = this.key(kind, name);
    let w = this.book.get(k);
    if (!w) this.book.set(k, (w = newWear(kind, name, zone)));
    if (zone && !w.zone) w.zone = zone;
    return w;
  }

  has(kind: ComponentKind, name: string): boolean {
    return this.book.has(this.key(kind, name));
  }

  all(): Wear[] {
    return [...this.book.values()];
  }

  /** Replaces the book with rows loaded from the database. */
  load(rows: Wear[]): void {
    this.book.clear();
    for (const r of rows) this.book.set(this.key(r.kind, r.name), { ...r });
  }

  /** One completed use: a gate cycle, a car parked, a light switched on. */
  countCycle(kind: ComponentKind, name: string, zone = ""): Wear {
    const w = this.get(kind, name, zone);
    w.cycles++;
    return w;
  }

  /** Adds on-time. Call when a device is switched off, or periodically while it runs. */
  addRuntime(kind: ComponentKind, name: string, gameSeconds: number, zone = ""): Wear {
    const w = this.get(kind, name, zone);
    if (gameSeconds > 0) w.runtime_game_s += gameSeconds;
    return w;
  }

  markBroken(kind: ComponentKind, name: string, at: string, zone = ""): Wear {
    const w = this.get(kind, name, zone);
    w.breakdowns++;
    w.last_broken_at = at;
    return w;
  }

  /** A repair landed: wear since last repair goes back to zero. */
  markRepaired(kind: ComponentKind, name: string, at: string, zone = ""): Wear {
    const w = this.get(kind, name, zone);
    w.repairs++;
    w.cycles_at_repair = w.cycles;
    w.runtime_at_repair = w.runtime_game_s;
    w.last_repair_at = at;
    return w;
  }

  /** Components at or past their threshold, worst first. */
  due(t: WearThresholds, now = Date.now()): Array<Wear & { ratio: number }> {
    return this.all()
      .map((w) => ({ ...w, ratio: wearRatio(w, t, now) }))
      .filter((w) => w.ratio >= 1)
      .sort((a, b) => b.ratio - a.ratio);
  }
}

// ---------------------------------------------------------------------------
// carbon monoxide
// ---------------------------------------------------------------------------
export interface CoThresholds {
  /** At or above this, ventilate. */
  onPpm: number;
  /**
   * Stop only once it falls below this. The gap between the two is deliberate: a single
   * threshold makes the fan chatter on and off around the boundary, and every one of
   * those flips is a usage cycle the brief asks us to conserve.
   */
  offPpm: number;
  /** Trust a "High"/"Danger" DangerLevel even if the number is below onPpm. */
  trustDangerWord: boolean;
}

export interface ZoneAir {
  zone: string;
  level: number;
  danger: string;
  /** What the controller should be doing about it right now. */
  ventilating: boolean;
  at: string;
  /** Readings at or above onPpm since the server started - for the daily report. */
  excursions: number;
  peak: number;
}

const isDangerWord = (danger: string): boolean =>
  CO_DANGER_WORDS.some((w) => danger.toLowerCase().includes(w));

/**
 * Per-zone CO state with hysteresis. Feed it readings; it says whether that zone's
 * fans should be running. It holds no timers and sends no commands.
 */
/** Zone names are compared loosely: "ZONE1", "Zone1" and " ZONE1 " are the same zone. */
export const zoneKey = (zone: string) => zone.trim().toLowerCase();

export class AirQuality {
  private readonly zones = new Map<string, ZoneAir>();

  /**
   * Thresholds are read through a getter, not captured: an admin can retune them from
   * the dashboard mid-run and the next reading must use the new values.
   */
  constructor(private readonly thresholds: () => CoThresholds) {}

  private get t(): CoThresholds {
    return this.thresholds();
  }

  get(zone: string): ZoneAir | undefined {
    return this.zones.get(zoneKey(zone));
  }

  /** True when any zone at all wants ventilation - what a fan with no zone follows. */
  get anyVentilating(): boolean {
    return [...this.zones.values()].some((z) => z.ventilating);
  }

  all(): ZoneAir[] {
    return [...this.zones.values()].sort((a, b) => a.zone.localeCompare(b.zone));
  }

  /** Any zone currently wanting ventilation. */
  ventilating(): string[] {
    return this.all().filter((z) => z.ventilating).map((z) => z.zone);
  }

  /**
   * Records a reading and returns the new state plus whether ventilation just changed,
   * so the caller can act only on transitions rather than on every reading.
   */
  update(zone: string, level: number, danger: string, at: string): { air: ZoneAir; changed: boolean } {
    const key = zoneKey(zone);
    const prev = this.zones.get(key);
    const was = prev?.ventilating ?? false;
    const dangerous = this.t.trustDangerWord && isDangerWord(danger);

    // Hysteresis: cross onPpm (or a danger word) to start, fall under offPpm to stop.
    let ventilating: boolean;
    if (!was) ventilating = level >= this.t.onPpm || dangerous;
    else ventilating = level >= this.t.offPpm || dangerous;

    const air: ZoneAir = {
      zone,
      level,
      danger,
      ventilating,
      at,
      excursions: (prev?.excursions ?? 0) + (level >= this.t.onPpm || dangerous ? 1 : 0),
      peak: Math.max(prev?.peak ?? 0, level),
    };
    this.zones.set(key, air);
    return { air, changed: ventilating !== was };
  }
}

// ---------------------------------------------------------------------------
// daylight
// ---------------------------------------------------------------------------
/**
 * "Lights should not work at day time of simulator." No endpoint is known to report the
 * in-world hour, and webhook ServerDateTime is wall-clock, so the window is configured
 * and read off the stamps the simulator sends. If a Level 2 probe turns up a real
 * daylight field, feed that in instead and delete this.
 *
 * fromHour < toHour is a normal window (07:00-19:00). fromHour > toHour wraps midnight.
 */
export function isDaytime(stamp: string | null | undefined, fromHour: number, toHour: number): boolean | null {
  if (!stamp) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(stamp);
  if (!m) return null;
  const hour = Number(m[1]) + Number(m[2]) / 60;
  return fromHour <= toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour;
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------
/** Turns whatever list-lights / list-exhaust-fans returned into Device records. */
export function devicesFrom(kind: "light" | "fan", rows: unknown): Device[] {
  if (!Array.isArray(rows)) return [];
  const out: Device[] = [];
  for (const raw of rows as SimDevice[]) {
    const d = normaliseDevice(raw ?? {});
    if (!d.name) continue;
    const dev = new Device(kind, d.name, d.zone);
    dev.on = d.on;
    dev.broken = d.broken;
    dev.maintenance = d.maintenance;
    out.push(dev);
  }
  return out;
}
