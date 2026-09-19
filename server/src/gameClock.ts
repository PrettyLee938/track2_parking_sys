/**
 * The simulator's clock, seen from outside.
 *
 * Cars, gates and sensors move in game time, which runs GameSpeedMultiplier times faster
 * than the wall clock - and the speed can be changed while the simulator runs (Shift+PgUp),
 * or the game paused. Nothing in the webhooks states either (their timestamps are
 * wall-clock), so both are inferred:
 *
 *   speed   - accurately from completed stays (a car stays exactly its planned game
 *             minutes), and quickly from gate movements: a barrier takes a fixed amount of
 *             game time to open or close, so when its real duration jumps, the speed has
 *             changed. Stays need a minute or two to catch up; gates notice in a few cycles.
 *   pauses  - no webhook at all for pauseAfterSilenceS: the clock stops until the next one,
 *             so a paused game does not age parked cars into "missed their exit".
 *
 * now() is game seconds since the server started (integrated over speed changes and
 * pauses); every game-time deadline in the controller is measured against it.
 */
import type { TimeScaleSource } from "@gpa/shared";
import type { Settings } from "./config";

export type ClockSettings = Pick<Settings, "gameSpeed" | "timeScaleSamples" | "timeScaleMinSamples" | "gateSpeedSamples" |
  "speedChangeThreshold" | "pauseAfterSilenceS">;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const CALIBRATION_SAMPLES = 20;
// Part of a gate's measured move time does not scale with game speed (HTTP round trip,
// webhook delivery, a rendered frame). Fitted on Level 1 runs at x1.7-x7.1: moves took
// 0.03 s + 0.48 game-s; ignoring the fixed part skews estimates by up to 25%.
const GATE_FIXED_S = 0.03;
// Plausible game speeds, and the least game time a real gate move takes (~0.5 measured).
const MIN_SPEED = 0.2, MAX_SPEED = 12, MIN_GATE_GAME_S = 0.3;

export class GameClock {
  private game = 0;                 // game seconds elapsed
  private active = 0;               // real seconds the simulator was running (pauses left out)
  private lastReal: number;
  private lastActivity: number | null = null;

  private stays: number[] = [];     // game seconds per real second, one per completed stay
  private gateTimes: number[] = []; // real seconds a gate took to move, most recent last
  private gateGameS: number[] = []; // the same in game seconds, while the speed was known from stays
  private fromGates: number | null = null; // speed read off the gates since a change they detected
  private changedAt = -Infinity;    // active() when that change was detected
  private pendingChange: number | null = null; // a first window's reading, awaiting confirmation
  private settingsSpeed: number | null = null;

  constructor(private readonly cfg: ClockSettings, private readonly realNow: () => number = () => Date.now() / 1000) {
    this.lastReal = realNow();
  }

  // ---------------------------------------------------------------------------
  // speed
  // ---------------------------------------------------------------------------
  get info(): { value: number; source: TimeScaleSource } {
    if (this.cfg.gameSpeed) return { value: this.cfg.gameSpeed, source: "configured" };
    if (this.fromGates) return { value: this.fromGates, source: "gate timing" };
    if (this.stays.length >= this.cfg.timeScaleMinSamples) return { value: median(this.stays), source: "learned" };
    if (this.settingsSpeed) return { value: this.settingsSpeed, source: "simulator settings" };
    return { value: 1, source: "default" };
  }

  get speed(): number {
    return this.info.value;
  }

  /** GameSpeedMultiplier from settings.json. The simulator reads it at startup, so a new
   * value means it was restarted at another speed: what was learned no longer applies. */
  setSettingsSpeed(speed: number | null): boolean {
    const changed = !!speed && !!this.settingsSpeed && speed !== this.settingsSpeed;
    if (changed) this.forgetSpeed();
    this.settingsSpeed = speed;
    return changed;
  }

  private forgetSpeed() {
    this.stays = [];
    this.gateTimes = [];
    this.gateGameS = [];
    this.fromGates = null;
  }

  /**
   * A car stayed plannedMin game minutes, parked and leaving at these active() stamps.
   * Stays that began before a detected speed change measure a mix of both speeds: skipped.
   */
  addStay(plannedMin: number | null, parkedActive: number | null, leftActive: number | null): void {
    if (!plannedMin || parkedActive === null || leftActive === null || parkedActive < this.changedAt) return;
    const realS = leftActive - parkedActive;
    if (realS <= 2) return;
    const ratio = (plannedMin * 60) / realS;
    if (!(ratio > 0.05 && ratio < 100)) return;
    this.stays.push(ratio);
    if (this.stays.length > this.cfg.timeScaleSamples) this.stays.shift();
    // Enough stays measured entirely at the new speed: they are more precise than gates.
    if (this.fromGates && this.stays.length >= this.cfg.timeScaleMinSamples) {
      this.fromGates = null;
      this.gateGameS = [];
    }
  }

  /**
   * A gate finished opening or closing realS after we told it to. Returns the new speed
   * when this reveals a speed change, else null.
   */
  addGateMove(realS: number): { from: number; to: number } | null {
    // A move takes ~0.5 game-s: even at x10 that is 0.08 s. Anything quicker was no move at all
    // (the gate already stood that way) - 2026-09-20 04:16: such readings (~0.03 s, minus the
    // 0.03 s fixed part) made the speed look like x100, the game clock raced, and 27 parked
    // cars were written off as overdue. Their spots then got second cars: occupied-spot fines.
    if (this.cfg.gameSpeed || !(realS >= GATE_FIXED_S + MIN_GATE_GAME_S / MAX_SPEED && realS < 10)) return null;
    this.gateTimes.push(realS);
    const n = this.cfg.gateSpeedSamples;
    if (this.gateTimes.length > n) this.gateTimes.shift();
    if (this.gateTimes.length < n) return null;
    const med = median(this.gateTimes);
    // Only a window that agrees with itself: one straddling a change says nothing yet.
    if (this.gateTimes.some((x) => Math.abs(x / med - 1) > this.cfg.speedChangeThreshold)) return null;
    const recent = Math.max(0.005, med - GATE_FIXED_S); // the part that runs on game time
    const { value, source } = this.info;
    // Speed known from stays: remember how many game seconds a gate move takes - but only
    // while the gates agree with it, so a change under way cannot skew the reference.
    const calibrate = () => {
      if (source !== "learned") return;
      const gameS = recent * value;
      if (this.gateGameS.length && Math.abs(gameS / median(this.gateGameS) - 1) > this.cfg.speedChangeThreshold) return;
      this.gateGameS.push(gameS);
      if (this.gateGameS.length > CALIBRATION_SAMPLES) this.gateGameS.shift();
    };
    if (this.gateGameS.length < n) {
      calibrate();
      return null;
    }
    const estimate = Math.min(MAX_SPEED, Math.max(MIN_SPEED, median(this.gateGameS) / recent));
    if (Math.abs(estimate / value - 1) <= this.cfg.speedChangeThreshold) {
      if (source === "gate timing") this.fromGates = estimate; // keep following until stays take over
      else calibrate();
      this.pendingChange = null;
      return null;
    }
    // A change must show in two windows in a row: one odd window (a gate that did not really
    // move, a repair in between) must not move the whole clock.
    if (this.pendingChange === null || Math.abs(estimate / this.pendingChange - 1) > this.cfg.speedChangeThreshold) {
      this.pendingChange = estimate;
      this.gateTimes = [];
      return null;
    }
    this.pendingChange = null;
    this.fromGates = estimate;
    this.changedAt = this.activeNow();
    this.stays = [];
    this.gateTimes = [];
    return { from: value, to: estimate };
  }

  // ---------------------------------------------------------------------------
  // time
  // ---------------------------------------------------------------------------
  private advance() {
    const now = this.realNow();
    let upTo = now;
    // Silent for too long: the game is paused (or on its menu) - stop counting.
    if (this.lastActivity !== null) upTo = Math.min(now, Math.max(this.lastReal, this.lastActivity + this.cfg.pauseAfterSilenceS));
    const dt = upTo - this.lastReal;
    if (dt > 0) {
      this.active += dt;
      this.game += dt * this.speed;
    }
    this.lastReal = now;
  }

  /** The wall clock this game clock reads (seconds). */
  real(): number {
    return this.realNow();
  }

  /** Game seconds elapsed. */
  now(): number {
    this.advance();
    return this.game;
  }

  /** Real seconds elapsed while the simulator was running. */
  activeNow(): number {
    this.advance();
    return this.active;
  }

  /** A webhook arrived: the simulator is running. */
  activity(): void {
    this.advance();
    this.lastActivity = this.realNow();
  }

  /** now() as it was at a past wall-clock time (for replayed events). */
  gameAt(realS: number | null): number {
    const now = this.now();
    return realS === null ? now : now - Math.max(0, this.lastReal - realS) * this.speed;
  }

  activeAt(realS: number | null): number {
    const now = this.activeNow();
    return realS === null ? now : now - Math.max(0, this.lastReal - realS);
  }

  /** Real seconds until a game-time deadline, at the current speed. */
  realUntil(gameDue: number): number {
    return Math.max(0, gameDue - this.now()) / this.speed;
  }
}
