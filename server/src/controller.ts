/**
 * The car park brain (workstream 1).
 *
 * Webhooks are handed to submit() and processed strictly one at a time through a
 * SerialQueue, together with the periodic tick and any resync. State lives in this
 * object and is only changed by those tasks, so handlers never interleave. The web
 * layer reads it through snapshot().
 *
 * The site is a set of lanes discovered at startup (see topology.ts): every entry
 * sensor has its own FIFO queue and barrier, every exit sensor its own barrier.
 *
 * Car lifecycle:
 *   entry CarIn   -> queue on that lane; turn away with "leavepark" if no spot will be left
 *   (dispatch)    -> reserve a spot, open the lane's gate, on gate Open: goto <spot>
 *   entry CarOut  -> dispatch the lane's next car, else close its gate after a delay
 *   spot CarIn    -> occupied, parking starts
 *   spot CarOut   -> spot free, parking ends; the car drives to an exit by itself
 *   exit CarIn    -> charge exactly once, after the sensor settles
 *   payment_made  -> amount == invoice ? open that exit's gate, goto leavepark : hold
 *   exit CarOut   -> session finished and stored; close the exit gate after a delay
 *
 * Car and spot records use the API's snake_case field names (see @gpa/shared api.ts)
 * so snapshot() can hand them to the dashboard as they are.
 */
import { randomUUID } from "node:crypto";
import {
  CORRECT_AMOUNT_PATTERN, OCCUPIED_SPOT_PATTERN, CarType, ComponentType, Destination, Direction, EventClass, GateState, PenaltyReason,
  SpotPurpose,
  type CarStatus, type CarView, type ControlResult, type Counters, type FeedItem, type FeedLevel, type GateAction,
  type GateHold, type SessionView, type SimParkingSpot, type StateSnapshot, type TimeScaleSource, type TimeseriesPoint,
  type ZoneSummary, type CoZoneSafetyState, type NormalizedExhaustFan, type NormalizedLight, type FanView, type LightView,
  type MaintenanceJobView,
} from "@gpa/shared";
import { getAllocator, spotNumber, type Allocator, type AllocSpot } from "./allocation";
import { chargingCost, parkingCost } from "./billing";
import { readSimGameSpeed, type Settings } from "./config";
import { GameClock } from "./gameClock";
import { SerialQueue, type TaskQueue } from "./serialQueue";
import type { SimApi } from "./simClient";
import type { ActionRecord, EventRecord, Store } from "./store";
import { matches, resolve as resolveTopology, type Topology } from "./topology";
import { parseCarbonMonoxideEvent, parseExhaustFans, parseLights, parseZones } from "./environment";
import { PersistedSimulatorCalendar } from "./simulatorCalendar";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const nowS = () => Date.now() / 1000;

/** Seconds between two simulator ServerDateTime stamps ("2026-09-12 15:26:50", wall-clock). */
export function simSecondsBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start.replace(" ", "T")), b = Date.parse(end.replace(" ", "T"));
  return Number.isNaN(a) || Number.isNaN(b) ? null : (b - a) / 1000;
}

const tsOf = (iso?: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t / 1000;
};

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const str = (e: EventRecord, k: string) => (e[k] as string | undefined) ?? undefined;

const ok = (message: string): ControlResult => ({ ok: true, message });
const fail = (message: string): ControlResult => ({ ok: false, message });

// =============================================================================
// state
// =============================================================================
export class Spot implements AllocSpot {
  broken = false;
  maintenance = false;
  manualOccupancy = false;
  manualOccupancyVersion = 0;
  /**
   * Plates physically in the spot ("?" = a car we cannot name). Normally 0 or 1 - but the
   * simulator lets a second car park in an occupied spot (it only fines it), and if we kept
   * a single plate, the first car leaving would mark the spot free while the other is
   * still in it: every car sent there next is fined too.
   */
  readonly occupants = new Set<string>();
  reserved_for: string | null = null; // plate sent here but not arrived yet
  detected = 0;                       // car count from the last list-parking-spots

  constructor(readonly name: string, public zone: string, readonly purpose: string, readonly car_type: string) {}

  /** A named occupant if there is one, "?" for an unknown car, null when empty. */
  get occupant(): string | null {
    for (const p of this.occupants) if (p !== "?") return p;
    return this.occupants.size || this.manualOccupancy ? "?" : null;
  }

  get available(): boolean {
    return this.purpose === SpotPurpose.Park && !this.broken && !this.maintenance &&
      this.occupants.size === 0 && !this.manualOccupancy && this.reserved_for === null;
  }

  accepts(carType: string): boolean {
    return this.car_type === CarType.Any || this.car_type.toLowerCase() === (carType ?? "").toLowerCase();
  }
}

type Callback = () => Promise<unknown> | unknown;

export class Gate {
  state: string = GateState.Closed;
  broken = false;
  maintenance = false;
  draining = false;
  drainCloseRetries = 0;
  onOpen: Callback[] = [];              // run once the gate reports Open
  hold: GateHold = null;                // operator override: held open/closed until back to automatic
  openRequestedAt: number | null = null;  // game clock
  openRetries = 0;
  closeRequestedAt: number | null = null; // game clock
  moveSentReal: number | null = null;     // a clean open/close was sent at this real time (speed sample)

  constructor(readonly name: string, public zone: string) {}

  get operable(): boolean {
    return !this.broken && !this.maintenance;
  }
}

export interface EntryLane {
  spot: string;
  gate: string | null;
  zone: string;
  queue: string[];         // plates waiting, FIFO
  current: string | null;  // plate dispatched, not yet off the sensor
  closed: boolean;         // closed by an admin: arriving cars are turned away
}

export interface ExitLane {
  spot: string;
  gate: string | null;
  zone: string;
  queue: string[];
  passageOwner: string | null;
  passageState: StateSnapshot["exit_lanes"][number]["passage_state"];
  closeRetries: number;
  clearanceCloseScheduled: boolean;
  releasing: Set<string>; // compatibility/read model: only the authorized passage owner
}

/**
 * Public fields mirror CarView; the camelCase ones are internal bookkeeping. *G fields are
 * game-clock stamps (GameClock.now()), so deadlines hold across speed changes and pauses.
 */
export interface Car extends CarView {
  arrivedG: number | null;
  dispatchedG: number | null;
  parkedG: number | null;
  leftSpotG: number | null;
  releasedG: number | null;      // when the exit gate was opened for it
  lastSeenG: number | null;      // last event about this plate
  gotoG: number | null;          // last goto sent for it (checkStuckGotos)
  gotoResends: number;
  parkedA: number | null;        // active real seconds (GameClock.activeNow), to learn the speed
  leftSpotA: number | null;
  chargeScheduled: boolean;
}

function newCar(plate: string, carType: string, planned: number | null, status: CarStatus, extra: Partial<Car> = {}): Car {
  return {
    visit_id: randomUUID(), state_version: 0, invoice_id: null, invoice_status: "none", approved_duration_minutes: null, billing_basis: null,
    plate, car_type: carType, planned_minutes: planned, status,
    entry_lane: null, exit_lane: null, arrived_at: null, spot: null, parked_at: null, left_spot_at: null,
    exit_at: null, charge_parking: null, charge_electric: null, charge_attempts: 0, charge_override: null,
    paid: null, payment_ok: null, left_at: null,
    arrivedG: null, dispatchedG: null, parkedG: null, leftSpotG: null, releasedG: null, lastSeenG: null,
    gotoG: null, gotoResends: 0, parkedA: null, leftSpotA: null, chargeScheduled: false,
    ...extra,
  };
}

export function publicCar(c: Car): CarView {
  const { arrivedG, dispatchedG, parkedG, leftSpotG, releasedG, lastSeenG, gotoG, gotoResends, parkedA, leftSpotA,
    chargeScheduled, ...view } = c;
  return view;
}

const AT_EXIT: CarStatus[] = ["at_exit", "invoiced", "payment_mismatch", "released"];
const MID_ENTRY: CarStatus[] = ["dispatching", "dispatched"];
const DEAD: CarStatus[] = ["turned_away", "neglected", "lost", "unknown"];

interface Timer { due: number; label: string; fn: Callback; done: boolean } // due: game clock

export interface ControllerDeps {
  sim: SimApi;
  cfg: Settings;
  store: Store;
  log?: Logger;
  /** Injected topologies (tests); otherwise loaded from cfg.topologyDir. */
  topologies?: Topology[];
  /** Where resyncs are scheduled; defaults to the controller's own serial queue. */
  queue?: TaskQueue;
  /** Injected clock (tests); otherwise one on the wall clock. */
  clock?: GameClock;
}

// =============================================================================
// controller
// =============================================================================
export class Controller {
  /** Fresh per controller/server instance; persisted manual anchors from other runs fail closed. */
  readonly processInstanceToken = randomUUID();
  readonly simulatorCalendar: PersistedSimulatorCalendar;
  readonly cfg: Settings;
  private readonly sim: SimApi;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly allocator: Allocator;
  private readonly topologyCandidates?: Topology[];
  readonly queue: TaskQueue;

  synced = false;
  replaying = false; // rebuilding state from the event log: no commands, no timers
  private replayPending = false;
  private started = false; // real timers only once running (tests drive time by hand)
  private readonly replayedIds = new Set<string>();
  private lastResyncRequest = 0;
  private readonly unresolvedSpots = new Map<string, number>(); // unknown entry/exit -> last resync
  private readonly coStates = new Map<string, CoZoneSafetyState>();
  private readonly exhaustFans = new Map<string, NormalizedExhaustFan>();
  private readonly lights = new Map<string, NormalizedLight>();
  private readonly fanBrokenOverrides = new Map<string, boolean>();
  private readonly fanMaintenanceOverrides = new Map<string, boolean>();
  private readonly componentSequences = new Map<string, { sequence: number; broken: boolean }>();
  private environmentDiscoveryAttempted = false;
  private fanInventoryAvailable = false;
  private fanInventoryComplete = false;
  private lightInventoryAvailable = false;
  private lightInventoryComplete = false;
  lastEventReal: number | null = null;
  private tickHandle: NodeJS.Timeout | null = null;
  private tickPending = false;
  private stopped = false;

  topology: Topology | null = null;
  spots = new Map<string, Spot>();
  gates = new Map<string, Gate>();
  entryLanes = new Map<string, EntryLane>();
  exitLanes = new Map<string, ExitLane>();
  cars = new Map<string, Car>();                  // active cars by plate
  recentPaid = new Map<string, number>();         // plate -> when its paid session ended (game clock)
  readonly clock: GameClock;
  timers: Timer[] = [];

  completed: SessionView[] = [];
  feed: FeedItem[] = [];
  counters: Counters = {
    arrived: 0, admitted: 0, turned_away: 0, neglected: 0, exited: 0, revenue: 0, payment_mismatches: 0,
    repeat_exits: 0, ghosts_retired: 0, escaped: 0, penalties: 0, fines: 0, command_errors: 0,
  };

  constructor(deps: ControllerDeps) {
    this.sim = deps.sim;
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.simulatorCalendar = new PersistedSimulatorCalendar(() => this.store.latestSimulatorCalendarRecord(), this.processInstanceToken);
    this.log = deps.log ?? console;
    this.allocator = getAllocator(this.cfg.allocationStrategy);
    this.topologyCandidates = deps.topologies;
    this.queue = deps.queue ?? new SerialQueue((err) => this.log.error(`controller task failed: ${(err as Error)?.stack ?? err}`));
    this.clock = deps.clock ?? new GameClock(this.cfg);
    this.clock.setSettingsSpeed(readSimGameSpeed(this.cfg.simSettingsFile));
    // Ventilation elapsed time must never survive process silence/restarts. Keep the
    // observation/restriction facts, but require fresh fan-on commands after sync.
    for (const persisted of this.store.coZoneStates()) {
      const restored = { ...persisted, ventilationStartedAtGame: null };
      this.coStates.set(restored.zone, restored);
      this.store.saveCoZoneState(restored);
    }
  }

  /** Game seconds per real second (= the simulator's GameSpeedMultiplier), and where
   * that figure came from. See gameClock.ts. */
  get timeScaleInfo(): { value: number; source: TimeScaleSource } {
    return this.clock.info;
  }

  get timeScale(): number {
    return this.clock.speed;
  }

  /** Real seconds for a duration the simulator measures in game time, at today's speed. */
  real(gameS: number): number {
    return gameS / this.timeScale;
  }

  /** Game-clock time when an event arrived (not when its turn in the queue came; and for
   * replayed events, minutes ago). */
  private gameAt(e: EventRecord): number {
    return this.clock.gameAt(tsOf(e._received_at));
  }

  private activeAt(e: EventRecord): number {
    return this.clock.activeAt(tsOf(e._received_at));
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------
  start(): void {
    this.started = true;
    // Events arriving before the first sync wait behind it in the queue; handling them
    // against an empty map would turn every car away.
    this.queue.push(() => this.initialSync());
    this.tickHandle = setInterval(() => {
      if (this.tickPending) return;
      this.tickPending = true;
      this.queue.push(async () => { this.tickPending = false; await this.tick(); });
    }, this.cfg.tickIntervalS * 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  submit(e: EventRecord): void {
    this.queue.push(() => this.handle(e));
  }

  requestResync(): void {
    this.queue.push(() => this.sync());
  }

  private async initialSync() {
    while (!this.stopped && !this.synced) {
      try {
        await this.sync({ replay: true });
      } catch (e) {
        this.log.warn(`sync failed (${(e as Error).message}), retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // sync (list-* endpoints are costly: startup, level change or crash only)
  // ---------------------------------------------------------------------------
  /** Load spots and gates, resolve the site topology and, on first start, rebuild
   * car state by replaying our event log. */
  async sync(opts: { replay?: boolean } = {}): Promise<void> {
    const liveSpots = await this.sim.listParkingSpots();
    const liveGates = await this.sim.listBarriers();
    this.refreshSimSettingsSpeed();

    const entry = new Set(liveSpots.filter((s) => s.purpose === SpotPurpose.Entry).map((s) => s.name));
    const exit = new Set(liveSpots.filter((s) => s.purpose === SpotPurpose.Exit).map((s) => s.name));
    if (opts.replay) this.replayPending = true;
    if (!entry.size && !exit.size) {
      // The simulator is up but on its menu: no level loaded. Not a site without lanes -
      // the first car event from an unknown entry triggers a reload (routeCarEvent).
      if (this.topology) this.reset();
      this.topology = null;
      this.synced = true;
      this.note("warn", "simulator has no level loaded yet - waiting for it");
      return;
    }
    const levelChanged = this.topology !== null && !matches(this.topology, entry, exit);
    const freshLayout = !this.topology || levelChanged;
    if (freshLayout) {
      if (levelChanged) {
        this.note("warn", "site layout changed (new level?) - resetting state");
        this.reset();
      }
      this.topology = resolveTopology(liveSpots, liveGates, {
        topologyDir: this.cfg.topologyDir, simLevelsDir: this.cfg.simLevelsDir,
        maxGateDistance: this.cfg.topologyMaxGateDistance, candidates: this.topologyCandidates, log: this.log,
      });
      this.entryLanes = new Map(this.topology.entry_lanes.map((l) => [l.spot, { ...l, queue: [], current: null, closed: false }]));
      this.exitLanes = new Map(this.topology.exit_lanes.map((l) => [l.spot, {
        ...l, queue: [], passageOwner: null, passageState: "idle" as const, closeRetries: 0,
        clearanceCloseScheduled: false, releasing: new Set<string>(),
      }]));
      this.environmentDiscoveryAttempted = false;
      this.fanInventoryAvailable = false;
      this.fanInventoryComplete = false;
      this.lightInventoryAvailable = false;
      this.lightInventoryComplete = false;
      this.exhaustFans.clear();
      this.lights.clear();
      this.fanBrokenOverrides.clear();
      this.fanMaintenanceOverrides.clear();
      this.componentSequences.clear();
    }

    if (!this.environmentDiscoveryAttempted) await this.discoverExhaustFans();

    for (const s of liveSpots) this.upsertSpot(s);
    this.restoreManualSpotOccupancy();
    if (this.replayPending) {
      this.replayPending = false;
      await this.replay();
    }
    // Live state wins over anything replayed.
    for (const g of liveGates) {
      const gate = this.gates.get(g.name) ?? new Gate(g.name, g.zoneParent || "");
      gate.state = g.state;
      gate.broken = g.broken;
      gate.maintenance = g.isUnderMaintenance;
      this.gates.set(gate.name, gate);
    }
    this.restoreActiveVisits();
    this.restoreActiveInvoices();
    this.reconcileMaintenanceJobs();
    await this.reconcile(freshLayout);
    await this.restoreCoVentilationAfterSync();
    this.synced = true;

    const park = [...this.spots.values()].filter((s) => s.purpose === SpotPurpose.Park);
    const speed = this.timeScaleInfo;
    this.note("info", `Synced '${this.topology!.name}': ${this.entryLanes.size} entries, ${this.exitLanes.size} exits, ` +
      `${park.length} park spots (${park.filter((s) => s.available).length} free); tracking ${this.cars.size} cars; ` +
      `game speed ${speed.value.toFixed(2)} (${speed.source})`);
    for (const lane of this.entryLanes.values()) await this.pumpEntry(lane);
    if (this.cfg.closeIdleGatesOnSync) {
      const names = new Set([...this.entryLanes.values(), ...this.exitLanes.values()].map((l) => l.gate).filter(Boolean));
      for (const name of names) await this.closeGateIfIdle(name);
    }
  }

  private async discoverExhaustFans(): Promise<void> {
    this.environmentDiscoveryAttempted = true;
    this.fanInventoryAvailable = false;
    this.fanInventoryComplete = false;
    this.exhaustFans.clear();
    if (!this.sim.listExhaustFans) {
      await this.discoverLights();
      return;
    }
    try {
      const parsed = parseExhaustFans(await this.sim.listExhaustFans());
      if (parsed.shape === "unknown") {
        this.note("error", "exhaust fan inventory has an unknown response shape; CO ventilation is unavailable");
        await this.discoverLights();
        return;
      }
      this.fanInventoryAvailable = true;
      this.fanInventoryComplete = parsed.rows.every((fan) => fan.name.available && fan.zoneParent.available);
      const counts = new Map<string, number>();
      for (const fan of parsed.rows) {
        if (!fan.name.available) continue;
        const name = fan.name.value;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      for (const fan of parsed.rows) {
        if (!fan.name.available) continue;
        const name = fan.name.value;
        if (counts.get(name) === 1) this.exhaustFans.set(name, fan);
        else {
          this.fanInventoryComplete = false;
          this.note("error", `duplicate exhaust fan name '${name}' in inventory; refusing to command it`);
        }
      }
      if (parsed.issues.length) this.note("warn", `exhaust fan inventory has ${parsed.issues.length} shape issue(s)`);
    } catch (cause) {
      this.note("error", `could not discover exhaust fans: ${(cause as Error).message}`);
    }
    await this.discoverLights();
  }

  private async discoverLights(): Promise<void> {
    this.lightInventoryAvailable = false;
    this.lightInventoryComplete = false;
    this.lights.clear();
    if (!this.sim.listLights) return;
    try {
      const parsed = parseLights(await this.sim.listLights());
      if (parsed.shape === "unknown") {
        this.note("warn", "light inventory has an unknown response shape; only simulator event diagnostics are available");
        return;
      }
      this.lightInventoryAvailable = true;
      this.lightInventoryComplete = parsed.rows.every((light) => light.name.available && light.zoneParent.available);
      const counts = new Map<string, number>();
      for (const light of parsed.rows) if (light.name.available) {
        counts.set(light.name.value, (counts.get(light.name.value) ?? 0) + 1);
      }
      for (const light of parsed.rows) {
        if (!light.name.available) continue;
        if (counts.get(light.name.value) === 1) this.lights.set(light.name.value, light);
        else this.lightInventoryComplete = false;
      }
    } catch (cause) {
      this.note("warn", `could not discover lights: ${(cause as Error).message}`);
    }
  }

  private fanRowsForZone(zone: string): NormalizedExhaustFan[] {
    return [...this.exhaustFans.values()].filter((fan) => fan.zoneParent.available && fan.zoneParent.value === zone);
  }

  /** A one-shot fresh inventory check used only before taking a fan offline during CO ventilation. */
  private async hasConfirmedRunningBackupFan(zone: string, exclude: string): Promise<boolean> {
    if (!this.sim.listExhaustFans) return false;
    let parsed;
    try { parsed = parseExhaustFans(await this.sim.listExhaustFans()); }
    catch { return false; }
    if (parsed.shape === "unknown" || !parsed.rows.every((fan) => fan.name.available && fan.zoneParent.available)) return false;
    const rows = parsed.rows.filter((fan) => fan.zoneParent.value === zone);
    const counts = new Map<string, number>();
    for (const row of rows) if (row.name.available) counts.set(row.name.value, (counts.get(row.name.value) ?? 0) + 1);
    for (const row of rows) {
      if (!row.name.available || row.name.value === exclude || counts.get(row.name.value) !== 1 ||
          !row.isOn.available || !row.isOn.value) continue;
      const name = row.name.value;
      const eventState = this.fanBrokenOverrides.get(name) ?? this.store.latestComponentBroken(ComponentType.ExhaustFan, name);
      if (eventState === true || this.fanMaintenanceOverrides.get(name) === true ||
          (row.broken.available && row.broken.value) || (row.isUnderMaintenance.available && row.isUnderMaintenance.value) ||
          (row.isRepairRequested.available && row.isRepairRequested.value) ||
          (row.repairProgress.available && row.repairProgress.value > 0)) continue;
      if (eventState === false || (row.broken.available && !row.broken.value) ||
          (row.isUnderMaintenance.available && !row.isUnderMaintenance.value) ||
          (row.isRepairRequested.available && !row.isRepairRequested.value)) return true;
    }
    return false;
  }

  private fanHealthy(fan: NormalizedExhaustFan): boolean {
    if (!fan.name.available) return false;
    const name = fan.name.value;
    const eventState = this.fanBrokenOverrides.get(name) ?? this.store.latestComponentBroken(ComponentType.ExhaustFan, name);
    if (this.fanMaintenanceOverrides.get(name) === true || eventState === true) return false;
    // An accepted component_fixed event is newer evidence than a stale discovery row.
    if (eventState === false) return true;
    if ((fan.broken.available && fan.broken.value) ||
        (fan.isUnderMaintenance.available && fan.isUnderMaintenance.value) ||
        (fan.isRepairRequested.available && fan.isRepairRequested.value) ||
        (fan.repairProgress.available && fan.repairProgress.value > 0)) return false;
    // A latest fixed event or at least one explicit false status is positive health
    // evidence; absent status fields are never treated as healthy by default.
    return eventState === false ||
      (fan.broken.available && !fan.broken.value) ||
      (fan.isUnderMaintenance.available && !fan.isUnderMaintenance.value) ||
      (fan.isRepairRequested.available && !fan.isRepairRequested.value);
  }

  private saveCoState(state: CoZoneSafetyState): void {
    this.coStates.set(state.zone, state);
    this.store.saveCoZoneState(state);
  }

  private async switchZoneFans(zone: string, on: boolean, actor: string | null, force = false): Promise<{ ok: boolean; reason: string | null }> {
    if (!this.fanInventoryAvailable) return { ok: false, reason: "exhaust fan inventory is unavailable" };
    const fans = this.fanRowsForZone(zone);
    if (!fans.length) return { ok: false, reason: `no exhaust fan is safely identified in ${zone}` };
    const healthy = fans.filter((fan) => this.fanHealthy(fan));
    // Still command any healthy hardware toward the safe on-state, but absence of a
    // required fan means the ventilation interval cannot be certified.
    if (on) {
      let commandFailed = false;
      for (const fan of healthy) {
        if (!fan.name.available) continue;
        const name = fan.name.value;
        const state = this.coStates.get(zone);
        if (!force && state?.ventilationStartedAtGame !== null && state?.ventilationStartedAtGame !== undefined) continue;
        const command = this.sim.fanOn;
        if (!command || !await this.cmd("fan_on", () => command.call(this.sim, name), [name], actor)) commandFailed = true;
      }
      if (!this.fanInventoryComplete) return { ok: false, reason: "one or more exhaust fan identities/zones are ambiguous or unavailable" };
      if (healthy.length !== fans.length) return { ok: false, reason: "one or more exhaust fans are broken, repairing, or have unknown health" };
      if (commandFailed) return { ok: false, reason: "one or more exhaust fan on commands failed or are unsupported" };
      const state = this.coStates.get(zone);
      if (state && state.ventilationStartedAtGame === null) {
        state.ventilationStartedAtGame = this.clock.now();
        this.saveCoState(state);
      }
      return { ok: true, reason: null };
    }

    if (!this.fanInventoryComplete) return { ok: false, reason: "exhaust fan inventory is incomplete; refusing to stop ventilation" };
    if (healthy.length !== fans.length) return { ok: false, reason: "one or more exhaust fans are not confirmed healthy" };
    let commandFailed = false;
    for (const fan of healthy) {
      if (!fan.name.available) continue;
      const name = fan.name.value;
      const command = this.sim.fanOff;
      if (!command || !await this.cmd("fan_off", () => command.call(this.sim, name), [name], actor)) commandFailed = true;
    }
    return commandFailed ? { ok: false, reason: "one or more exhaust fan off commands failed or are unsupported" } : { ok: true, reason: null };
  }

  private async restoreCoVentilationAfterSync(): Promise<void> {
    for (const state of this.coStates.values()) {
      if (!state.ventilationRequired && !state.restricted) continue;
      // The timer was reset in the constructor. Force commands even if list data says
      // IsOn=true: the duration must begin from a command in this process lifetime.
      state.ventilationStartedAtGame = null;
      const result = await this.switchZoneFans(state.zone, true, "system", true);
      if (!result.ok) {
        state.restricted = true;
        state.restrictionReason = result.reason;
        this.raiseCoIncident(state, "critical");
      }
      this.saveCoState(state);
    }
  }

  private raiseCoIncident(state: CoZoneSafetyState, severity: "high" | "critical"): void {
    if (!state.restricted) return;
    this.store.createOrUpdateIncident({
      type: "co_safety", correlationKey: state.zone, severity,
      summary: `CO safety restriction is active in ${state.zone}${state.restrictionReason ? `: ${state.restrictionReason}` : ""}`,
      zone: state.zone,
      details: { level: state.level, danger_level: state.dangerLevel, restricted: true,
        restriction_reason: state.restrictionReason, source: state.source, observed_at: state.observedAt },
    });
  }

  private async onCarbonMonoxide(e: EventRecord): Promise<void> {
    // Controller.submit is fed only after intake acceptance; enforce the invariant here
    // too because tests/replay/debug callers can invoke handle() directly.
    if (e._accepted !== true) return;
    const event = parseCarbonMonoxideEvent(e);
    if (!event.isCarbonMonoxideEvent || !event.zoneName.available) {
      this.note("warn", "accepted CO webhook lacks an unambiguous zone; existing CO restrictions remain in force");
      return;
    }
    const zone = event.zoneName.value;
    const previous = this.coStates.get(zone);
    const signedDanger = e._sig === "valid" && event.dangerLevel.available
      ? event.dangerLevel.value.trim().toLowerCase() : "";
    const fanTrigger = (event.carbonMonoxideLevel.available && event.carbonMonoxideLevel.value >= 50) ||
      ["mid", "high", "critical"].includes(signedDanger);
    const highDanger = ["high", "critical"].includes(signedDanger);
    const criticalDanger = signedDanger === "critical";
    const state: CoZoneSafetyState = {
      zone,
      level: event.carbonMonoxideLevel.available ? event.carbonMonoxideLevel.value : null,
      dangerLevel: event.dangerLevel.available ? event.dangerLevel.value : null,
      source: "webhook",
      sourceEventId: event.eventId.available ? event.eventId.value : null,
      observedAt: new Date().toISOString(),
      raw: event.raw,
      restricted: previous?.restricted ?? false,
      restrictionReason: previous?.restrictionReason ?? null,
      ventilationRequired: (previous?.ventilationRequired ?? false) || fanTrigger,
      ventilationStartedAtGame: previous?.ventilationStartedAtGame ?? null,
      verifiedAt: previous?.verifiedAt ?? null,
    };
    if (highDanger) {
      state.restricted = true;
      state.restrictionReason = `signed ${event.dangerLevel.value} carbon monoxide danger`;
    }
    this.saveCoState(state);

    let fanFailure = false;
    if (fanTrigger || state.ventilationRequired || state.restricted) {
      if (this.replaying) return; // state is rebuilt; sync reasserts fans before admissions resume
      const result = await this.switchZoneFans(zone, true, "system");
      if (!result.ok) {
        fanFailure = true;
        state.restricted = true;
        state.restrictionReason = result.reason;
      }
    }
    if (state.restricted) this.raiseCoIncident(state, criticalDanger || fanFailure ? "critical" : "high");
    this.saveCoState(state);
    this.note(state.restricted ? "error" : fanTrigger ? "warn" : "info",
      `CO zone ${zone}: ${state.level === null ? "unknown" : state.level}${state.dangerLevel ? ` (${state.dangerLevel})` : ""}` +
      `${state.restricted ? "; admissions restricted" : state.ventilationRequired ? "; ventilation requested" : ""}`);
  }

  /** Latest operational CO summary; raw signed webhook payloads are kept private. */
  coSafetySnapshot(): Array<Omit<CoZoneSafetyState, "raw">> {
    return [...this.coStates.values()].sort((a, b) => a.zone.localeCompare(b.zone)).map(({ raw: _raw, ...state }) => state);
  }

  fanSnapshot(): FanView[] {
    return [...this.exhaustFans.values()].flatMap((fan) => {
      if (!fan.name.available || !fan.zoneParent.available) return [];
      const name = fan.name.value, zone = fan.zoneParent.value;
      const eventState = this.fanBrokenOverrides.get(name) ?? this.store.latestComponentBroken(ComponentType.ExhaustFan, name);
      const maintenance = this.fanMaintenanceOverrides.get(name) === true ? true
        : fan.isUnderMaintenance.available ? fan.isUnderMaintenance.value
          : fan.isRepairRequested.available ? fan.isRepairRequested.value
            : fan.repairProgress.available && fan.repairProgress.value > 0 ? true : null;
      const broken = eventState !== null ? eventState : fan.broken.available ? fan.broken.value : null;
      const healthyEvidence = eventState === false || (fan.broken.available && !fan.broken.value) ||
        (fan.isUnderMaintenance.available && !fan.isUnderMaintenance.value) ||
        (fan.isRepairRequested.available && !fan.isRepairRequested.value);
      return [{
        name, zone,
        is_on: fan.isOn.available ? fan.isOn.value : null,
        broken, maintenance, health_known: broken !== null || maintenance !== null || healthyEvidence,
        usage_count: fan.usageCounter.available ? fan.usageCounter.value : null,
      }];
    }).sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
  }

  lightSnapshot(): LightView[] {
    return [...this.lights.values()].flatMap((light) => {
      if (!light.name.available || !light.zoneParent.available) return [];
      return [{ name: light.name.value, zone: light.zoneParent.value,
        group: light.group.available ? light.group.value : null,
        is_on: light.isOn.available ? light.isOn.value : null,
        broken: light.broken.available ? light.broken.value : null,
        maintenance: light.isUnderMaintenance.available ? light.isUnderMaintenance.value : null,
        usage_count: light.usageCounter.available ? light.usageCounter.value : null }];
    }).sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
  }

  equipmentInventoryStatus() {
    return { fan_inventory_complete: this.fanInventoryAvailable && this.fanInventoryComplete,
      light_inventory_complete: this.lightInventoryAvailable && this.lightInventoryComplete };
  }

  private async onExhaustFanComponent(name: string, broken: boolean): Promise<void> {
    this.fanBrokenOverrides.set(name, broken);
    if (!broken) {
      this.fanMaintenanceOverrides.delete(name);
      this.store.confirmCommandIntent("repair", [name]);
      this.store.finishMaintenanceJob("fan", name, "simulator reported exhaust fan fixed");
      this.store.resolveIncidentByCorrelation("component_unavailable", `ExhaustFan:${name}`, "system", "simulator reported the fan fixed");
    } else {
      const fan = this.exhaustFans.get(name);
      this.store.createOrUpdateIncident({ type: "component_unavailable", correlationKey: `ExhaustFan:${name}`,
        severity: "high", summary: `Exhaust fan ${name} is broken`, component: name, componentType: "fan",
        zone: fan?.zoneParent.available ? fan.zoneParent.value : null, details: { simulator_type: ComponentType.ExhaustFan } });
    }
    const zones = new Set<string>();
    const fan = this.exhaustFans.get(name);
    if (fan?.zoneParent.available) zones.add(fan.zoneParent.value);
    // If inventory could not correlate the failed component, fail-safe every zone that
    // currently depends on ventilation rather than guessing which zone it serves.
    if (!zones.size) for (const state of this.coStates.values()) {
      if (state.ventilationRequired || state.restricted) zones.add(state.zone);
    }
    this.note(broken ? "error" : "info", `ExhaustFan ${name} ${broken ? "BROKEN" : "fixed"}`);
    for (const zone of zones) {
      const state = this.coStates.get(zone);
      if (!state || (!state.ventilationRequired && !state.restricted)) continue;
      if (broken) {
        state.ventilationStartedAtGame = null;
        state.restricted = true;
        state.restrictionReason = `required exhaust fan ${name} is broken`;
        this.raiseCoIncident(state, "critical");
        await this.switchZoneFans(zone, true, "system"); // any other healthy fan is still commanded on
      } else if (!this.replaying) {
        const result = await this.switchZoneFans(zone, true, "system", true);
        if (!result.ok) {
          state.restricted = true;
          state.restrictionReason = result.reason;
          this.raiseCoIncident(state, "critical");
        }
      }
      this.saveCoState(state);
    }
  }

  /** Explicit operator/admin one-shot check. No timers or background polling recover a zone. */
  async verifyCoRecovery(zone: string, actor: string): Promise<
    { status: "verified"; zone: string; level: number; verified_at: string } |
    { status: "not_ready" | "unavailable" | "unsafe"; zone: string; reason: string; ventilation_started_at_game: number | null }
  > {
    const unavailable = (status: "not_ready" | "unavailable" | "unsafe", reason: string) => ({
      status, zone, reason, ventilation_started_at_game: this.coStates.get(zone)?.ventilationStartedAtGame ?? null,
    });
    const state = this.coStates.get(zone);
    if (!state) return unavailable("unavailable", "no accepted CO observation exists for this zone");
    if (!this.cfg.coMinimumVentilationGameS) return unavailable("unavailable", "CO recovery is disabled until a calibrated game-time interval is configured");
    if (!this.sim.listZones) return unavailable("unavailable", "the simulator does not expose list-zones");
    if (state.ventilationStartedAtGame === null) {
      const started = await this.switchZoneFans(zone, true, actor, true);
      if (!started.ok) {
        state.restricted = true;
        state.restrictionReason = started.reason;
        this.raiseCoIncident(state, "critical");
        this.saveCoState(state);
        return unavailable("unavailable", started.reason ?? "ventilation could not be confirmed");
      }
      state.ventilationStartedAtGame = this.clock.now();
      this.saveCoState(state);
    }
    if (this.clock.now() - state.ventilationStartedAtGame < this.cfg.coMinimumVentilationGameS) {
      return unavailable("not_ready", `minimum ventilation interval (${this.cfg.coMinimumVentilationGameS} game-seconds) has not elapsed`);
    }

    let zones;
    try {
      zones = parseZones(await this.sim.listZones());
    } catch (cause) {
      return unavailable("unavailable", `list-zones failed: ${(cause as Error).message}`);
    }
    if (zones.shape === "unknown") return unavailable("unavailable", "list-zones response shape is unknown");
    const matchingRows = zones.rows.filter((row) => row.name.available && row.name.value === zone);
    if (matchingRows.length !== 1 || !matchingRows[0].carbonMonoxideLevel.available) {
      state.level = null;
      state.source = "list-zones";
      state.observedAt = new Date().toISOString();
      state.raw = zones.raw;
      state.restricted = state.restricted || state.ventilationRequired;
      state.restrictionReason = state.restrictionReason ?? "current CO level is unavailable; ventilation remains on";
      this.saveCoState(state);
      return unavailable("unavailable", "list-zones did not provide exactly one zone with a numeric CarbonMonoxideLevel");
    }
    const row = matchingRows[0];
    if (!row.carbonMonoxideLevel.available) return unavailable("unavailable", "zone has no numeric CarbonMonoxideLevel");
    const level = row.carbonMonoxideLevel.value;
    const danger = row.dangerLevel.available ? row.dangerLevel.value.trim().toLowerCase() : "";
    state.level = level;
    state.dangerLevel = row.dangerLevel.available ? row.dangerLevel.value : null;
    state.source = "list-zones";
    state.sourceEventId = null;
    state.observedAt = new Date().toISOString();
    state.raw = row.raw;
    if (level >= 40 || ["high", "critical"].includes(danger)) {
      state.restricted = true;
      state.restrictionReason = `recovery check measured CO ${level}${danger ? ` (${danger})` : ""}; expected below 40`;
      this.raiseCoIncident(state, danger === "critical" ? "critical" : "high");
      this.saveCoState(state);
      return unavailable("unsafe", state.restrictionReason);
    }

    const stopped = await this.switchZoneFans(zone, false, actor);
    if (!stopped.ok) {
      // A partial stop is uncertain: immediately attempt to restore the safe state and
      // keep the restriction until another explicit check succeeds.
      const restarted = await this.switchZoneFans(zone, true, actor, true);
      state.restricted = true;
      state.restrictionReason = stopped.reason ?? "fan shutdown outcome is unknown";
      if (restarted.ok && state.ventilationStartedAtGame === null) state.ventilationStartedAtGame = this.clock.now();
      this.raiseCoIncident(state, "critical");
      this.saveCoState(state);
      return unavailable("unavailable", `fan shutdown was not fully confirmed; fans were commanded on again (${state.restrictionReason})`);
    }
    state.ventilationRequired = false;
    state.ventilationStartedAtGame = null;
    state.restricted = false;
    state.restrictionReason = null;
    state.verifiedAt = new Date().toISOString();
    this.store.resolveIncidentByCorrelation("co_safety", zone, actor, `manual recovery check measured CO ${level} below 40`);
    this.saveCoState(state);
    // Arrivals that were already waiting when the zone became unsafe stay queued.
    // Resume them only after the explicit fresh recovery check has cleared the hold.
    for (const lane of this.entryLanes.values()) if (lane.zone === zone) await this.pumpEntry(lane);
    return { status: "verified", zone, level, verified_at: state.verifiedAt };
  }

  /** The simulator reads settings.json when it starts: a new value there means it was
   * restarted at another speed, so stays learned at the old speed no longer apply. */
  private refreshSimSettingsSpeed() {
    const speed = readSimGameSpeed(this.cfg.simSettingsFile);
    if (this.clock.setSettingsSpeed(speed)) this.note("info", `simulator settings.json game speed is now ${speed}; relearning`);
  }

  private upsertSpot(s: SimParkingSpot) {
    const spot = this.spots.get(s.name) ?? new Spot(s.name, s.zoneParent || "", s.purpose, s.parkingForCarType || CarType.Any);
    spot.broken = s.broken;
    spot.maintenance = s.isUnderMaintenance;
    spot.detected = Number(s.detectedCars) || 0; // a count on Level 1, not a list of plates
    this.spots.set(spot.name, spot);
  }

  /** Reapply active human occupancy quarantines after every equipment inventory refresh.
   * A zero sensor count is not evidence that a manually reported vehicle has left. */
  private restoreManualSpotOccupancy() {
    for (const persisted of this.store.manualSpotOccupancyStates()) {
      const spot = this.spots.get(persisted.spot);
      if (!spot) continue;
      spot.manualOccupancy = persisted.occupied;
      spot.manualOccupancyVersion = persisted.version;
      if (persisted.occupied) {
        this.store.createOrUpdateIncident({ type: "manual_spot_occupancy", correlationKey: spot.name, severity: "high",
          summary: `${spot.name} is quarantined after a manual occupancy report`, component: spot.name,
          componentType: "spot", zone: spot.zone, reason: persisted.reason,
          details: { state_version: persisted.version, reported_by: persisted.actor, reported_at: persisted.at,
            observation: persisted.observation, manual_clearance_required: true } });
      } else {
        this.store.resolveIncidentByCorrelation("manual_spot_occupancy", spot.name, "system",
          "restored from the persisted, audited physical-clearance confirmation");
      }
    }
  }

  reportManualSpotOccupancy(spotName: string, requestId: string, expectedVersion: number, observation: string,
    reason: string, actor: string, actorId: number): ControlResult {
    const spot = this.spots.get(spotName);
    if (!spot || spot.purpose !== SpotPurpose.Park) return fail(`unknown parking spot ${spotName}`);
    if (requestId.trim().length < 8 || !Number.isInteger(expectedVersion) || expectedVersion < 0 ||
        observation.trim().length < 8 || reason.trim().length < 8) return fail("request ID, version, physical observation, and reason are required");
    const prior = this.store.manualSpotOccupancyRequest(requestId.trim());
    if (prior) return prior.spot === spotName && prior.action === "spot.manual_occupancy.reported"
      ? ok(prior.result) : fail("request ID was already used for a different occupancy action");
    const persisted = this.store.manualSpotOccupancyState(spotName);
    if (persisted.version !== expectedVersion) return fail("spot occupancy changed since it was loaded; refresh and retry with the current version");
    if (persisted.occupied) return fail(`${spotName} is already quarantined by a manual occupancy report`);
    if (spot.reserved_for) return fail(`${spotName} has an active reservation; resolve that visit before reporting manual occupancy`);
    if ([...spot.occupants].some((plate) => plate !== "?")) return fail(`${spotName} has a tracked vehicle; resolve its visit before reporting an additional occupant`);

    const version = persisted.version + 1;
    const result = `${spotName} quarantined after a physical occupancy observation (version ${version})`;
    this.store.recordManualSpotOccupancy({ actorId, actorUsername: actor, action: "spot.manual_occupancy.reported",
      spot: spotName, version, requestId: requestId.trim(), reason: reason.trim(), observation: observation.trim(), result });
    spot.manualOccupancy = true;
    spot.manualOccupancyVersion = version;
    this.store.createOrUpdateIncident({ type: "manual_spot_occupancy", correlationKey: spotName, severity: "high",
      summary: `${spotName} is quarantined after a manual occupancy report`, component: spotName,
      componentType: "spot", zone: spot.zone, reason: reason.trim(),
      details: { state_version: version, request_id: requestId.trim(), reported_by: actor,
        observation: observation.trim(), manual_clearance_required: true } });
    this.note("warn", `${actor} manually reported an unidentified occupant in ${spotName}; the spot is quarantined`);
    return ok(result);
  }

  private async freshManualClearanceSensorEvidence(spotName: string): Promise<
    { ok: true; count: 0 } | { ok: false; reason: string; count?: number }
  > {
    let rows: unknown;
    try {
      rows = await this.sim.listParkingSpots();
    } catch (cause) {
      return { ok: false, reason: `fresh parking-spot inventory failed: ${(cause as Error).message}` };
    }
    if (!Array.isArray(rows)) return { ok: false, reason: "fresh parking-spot inventory has an unknown response shape" };
    const matching = rows.filter((row) => typeof row === "object" && row !== null &&
      (row as Record<string, unknown>).name === spotName) as Record<string, unknown>[];
    if (matching.length !== 1) return { ok: false, reason: `fresh inventory returned ${matching.length} rows for ${spotName}; exactly one is required` };
    const count = matching[0].detectedCars;
    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      return { ok: false, reason: `fresh occupancy evidence for ${spotName} is missing or ambiguous; an integral detector count is required` };
    }
    if (count !== 0) return { ok: false, reason: `fresh simulator detector still reports ${count} vehicle(s) in ${spotName}`, count };
    return { ok: true, count: 0 };
  }

  async clearManualSpotOccupancy(spotName: string, requestId: string, expectedVersion: number, observation: string,
    reason: string, actor: string, actorId: number): Promise<ControlResult> {
    const spot = this.spots.get(spotName);
    if (!spot || spot.purpose !== SpotPurpose.Park) return fail(`unknown parking spot ${spotName}`);
    if (requestId.trim().length < 8 || !Number.isInteger(expectedVersion) || expectedVersion < 0 ||
        observation.trim().length < 8 || reason.trim().length < 8) return fail("request ID, version, physical observation, and reason are required");
    const prior = this.store.manualSpotOccupancyRequest(requestId.trim());
    if (prior) return prior.spot === spotName && prior.action === "spot.manual_occupancy.cleared"
      ? ok(prior.result) : fail("request ID was already used for a different occupancy action");
    const persisted = this.store.manualSpotOccupancyState(spotName);
    if (persisted.version !== expectedVersion) return fail("spot occupancy changed since it was loaded; refresh and retry with the current version");
    if (!persisted.occupied) return fail(`${spotName} has no active manual occupancy quarantine`);
    if (spot.reserved_for) return fail(`${spotName} still has an active reservation; resolve that visit before clearing occupancy`);
    if ([...spot.occupants].some((plate) => plate !== "?")) return fail(`${spotName} still has a tracked vehicle; its visit must be resolved first`);
    const detector = await this.freshManualClearanceSensorEvidence(spotName);
    if (!detector.ok) {
      if (detector.count && detector.count > 0) {
        spot.detected = detector.count;
        spot.occupants.add("?");
      }
      return fail(detector.reason);
    }

    const version = persisted.version + 1;
    const result = `${spotName} manual occupancy quarantine cleared after a physical-clearance observation (version ${version})`;
    this.store.recordManualSpotOccupancy({ actorId, actorUsername: actor, action: "spot.manual_occupancy.cleared",
      spot: spotName, version, requestId: requestId.trim(), reason: reason.trim(), observation: observation.trim(), result,
      sensorEvidence: { representation: "count", count: detector.count } });
    spot.detected = detector.count;
    spot.manualOccupancy = false;
    spot.manualOccupancyVersion = version;
    spot.occupants.delete("?");
    this.store.resolveIncidentByCorrelation("manual_spot_occupancy", spotName, actor,
      `physical clearance observed: ${observation.trim()}; ${reason.trim()}`);
    this.note("info", `${actor} cleared the manual occupancy quarantine on ${spotName} after physical observation`);
    return ok(result);
  }

  /**
   * Invoice records outlive the bounded webhook replay window. Reattach only by the
   * stable visit ID reconstructed from the accepted events; if that evidence is absent,
   * create a review incident instead of guessing from a reused plate or retrying a charge.
   */
  private restoreActiveInvoices() {
    for (const invoice of this.store.activeInvoices()) {
      const car = [...this.cars.values()].find((candidate) => candidate.visit_id === invoice.visit_id);
      if (!car) {
        this.store.createOrUpdateIncident({ type: "unmatched_active_invoice", correlationKey: invoice.id,
          severity: "high", summary: `Invoice ${invoice.id} has no safely reconstructed active visit`, plate: invoice.plate,
          details: { invoice_id: invoice.id, visit_id: invoice.visit_id, status: invoice.status, do_not_recharge: true } });
        continue;
      }
      this.applyInvoice(car, invoice);
      const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
      if (lane?.passageOwner === car.plate && lane.passageState === "uncertain") car.status = "unknown";
      if (invoice.status === "pending" || invoice.status === "outcome_unknown") {
        // A crash may have happened after the simulator accepted a charge but before its
        // result was stored. Never resend it automatically.
        car.invoice_status = "outcome_unknown";
        this.store.updateInvoiceStatus(invoice.id, "outcome_unknown");
        this.store.createOrUpdateIncident({ type: "invoice_outcome_unknown", correlationKey: invoice.id,
          severity: "high", summary: `Invoice result is unknown for ${car.plate}; verify before any manual recovery`,
          plate: car.plate, lane: car.exit_lane, details: { invoice_id: invoice.id, visit_id: invoice.visit_id, do_not_recharge: true } });
      }
    }
  }

  /**
   * The webhook replay window is intentionally bounded. On Level 2, older active visits
   * therefore come from the durable visit ledger. Restore their identity, but quarantine
   * any location that the simulator cannot corroborate; a restart must never free a
   * possibly reserved/occupied space or automatically release an uncertain exit car.
   */
  private restoreActiveVisits() {
    if (this.cfg.webhookProfile !== "level2") return;
    for (const row of this.store.activeVisitStates()) {
      const data = row.data as Partial<CarView>;
      const already = this.cars.get(row.plate);
      if (already?.visit_id === row.visit_id) continue;
      if (already && already.visit_id !== row.visit_id) {
        this.store.closeVisit(row.visit_id, "superseded", { reason: "a newer visit was reconstructed from accepted events" });
        continue;
      }
      const car = newCar(row.plate, data.car_type ?? CarType.Normal, data.planned_minutes ?? null, "unknown", {
        visit_id: row.visit_id, invoice_id: data.invoice_id ?? null, invoice_status: data.invoice_status ?? "none",
        approved_duration_minutes: data.approved_duration_minutes ?? null, billing_basis: data.billing_basis ?? null,
        entry_lane: data.entry_lane ?? null, exit_lane: data.exit_lane ?? null, arrived_at: data.arrived_at ?? null,
        spot: data.spot ?? null, parked_at: data.parked_at ?? null, left_spot_at: data.left_spot_at ?? null,
        exit_at: data.exit_at ?? null, charge_parking: data.charge_parking ?? null, charge_electric: data.charge_electric ?? null,
        charge_attempts: data.charge_attempts ?? 0, charge_override: data.charge_override ?? null, paid: data.paid ?? null,
        payment_ok: data.payment_ok ?? null, left_at: data.left_at ?? null,
      });
      const spot = car.spot ? this.spots.get(car.spot) : undefined;
      const exitLane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
      const rowSaysParked = data.status === "parked" && !!spot;
      const rowSaysAtExit = !!exitLane && ["at_exit", "invoiced", "payment_mismatch", "released", "unknown"].includes(data.status ?? "");
      if (rowSaysAtExit) {
        // Even a stored payment is not enough to replay a departure command after restart.
        car.status = "unknown";
        if (!exitLane!.queue.includes(car.plate)) exitLane!.queue.push(car.plate);
        exitLane!.passageOwner ??= car.plate;
        exitLane!.passageState = "uncertain";
        this.store.createOrUpdateIncident({ type: "uncertain_exit_passage", correlationKey: exitLane!.spot,
          severity: "critical", summary: `Persisted exit visit ${car.plate} needs physical reconciliation after restart`,
          plate: car.plate, lane: exitLane!.spot,
          details: { visit_id: car.visit_id, last_status: data.status, detected: this.spots.get(exitLane!.spot)?.detected ?? null,
            payment_ok: data.payment_ok ?? null, do_not_release_automatically: true } });
      } else if (rowSaysParked && spot!.detected > 0) {
        car.status = "parked";
        spot!.occupants.add(car.plate);
      } else if (car.spot && spot) {
        // A missing or ambiguous sensor result is not proof the reservation is free.
        spot.reserved_for = car.plate;
        spot.maintenance = true;
        this.store.createOrUpdateIncident({ type: "uncertain_reservation", correlationKey: car.visit_id!, severity: "high",
          summary: `${car.plate}'s location/reservation is uncertain after restart; ${spot.name} is quarantined`,
          plate: car.plate, component: spot.name, componentType: "spot", zone: spot.zone,
          details: { visit_id: car.visit_id, last_status: data.status, detected: spot.detected } });
      } else {
        this.store.createOrUpdateIncident({ type: "uncertain_visit_recovery", correlationKey: car.visit_id!, severity: "high",
          summary: `Active visit ${car.plate} could not be located from current simulator state`, plate: car.plate,
          details: { visit_id: car.visit_id, last_status: data.status, spot: data.spot ?? null, exit_lane: data.exit_lane ?? null } });
      }
      this.cars.set(car.plate, car);
      this.store.saveVisitState(publicCar(car));
      this.note("warn", `restored durable visit ${car.plate} as ${car.status}; location requires live confirmation`);
    }
  }

  /** Preserve an unfinished job as unavailable until the simulator confirms healthy state. */
  private reconcileMaintenanceJobs() {
    for (const job of this.store.activeMaintenanceJobs()) {
      const target = job.component_type === "gate" ? this.gates.get(job.component) :
        job.component_type === "spot" ? this.spots.get(job.component) : undefined;
      if (job.component_type === "fan") {
        const fan = this.exhaustFans.get(job.component);
        if (!fan) continue;
        const repairAttempt = this.store.repairCommandSince(job.component, job.requested_at);
        if (job.status === "requested" && !repairAttempt) continue;
        if (repairAttempt?.status === "rejected") {
          this.fanMaintenanceOverrides.delete(job.component);
          this.store.updateMaintenanceJob(job.id, "failed", "persisted repair command was rejected");
          continue;
        }
        const healthy = this.fanHealthy(fan) && this.fanMaintenanceOverrides.get(job.component) !== true;
        if (healthy && repairAttempt) {
          this.fanMaintenanceOverrides.delete(job.component);
          this.store.updateMaintenanceJob(job.id, "completed", "healthy fan state confirmed during startup reconciliation");
          this.store.recordAudit({ actorUsername: "system", action: "maintenance.reconciled", target: job.component,
            details: { job_id: job.id, command_id: repairAttempt.id, result: "healthy" } });
        } else {
          this.fanMaintenanceOverrides.set(job.component, true);
          if (repairAttempt?.status === "outcome_unknown") this.store.createOrUpdateIncident({ type: "repair_outcome_unknown",
            correlationKey: job.id, severity: "high", summary: `Repair result for ${job.component} is unknown; do not submit another repair`,
            component: job.component, componentType: "fan", zone: fan.zoneParent.available ? fan.zoneParent.value : job.zone,
            details: { job_id: job.id, command_id: repairAttempt.id, command_status: repairAttempt.status } });
        }
        continue;
      }
      if (!target) continue; // retain jobs for components in another or temporarily unloaded level
      const repairAttempt = this.store.repairCommandSince(job.component, job.requested_at);
      if (job.status === "requested" && !repairAttempt) continue; // request was never started; do not mark it complete
      if (job.component_type === "gate" && job.status === "in_progress" && !repairAttempt &&
          job.resolution?.startsWith("waiting for lane clearance")) {
        (target as Gate).draining = true;
        continue;
      }
      if (repairAttempt?.status === "rejected") {
        if (job.component_type === "gate") (target as Gate).draining = false;
        this.store.updateMaintenanceJob(job.id, "failed", "persisted repair command was rejected");
        continue;
      }
      if (!target.broken && !target.maintenance) {
        if (job.component_type === "gate") {
          (target as Gate).draining = false;
          (target as Gate).drainCloseRetries = 0;
        }
        this.store.updateMaintenanceJob(job.id, "completed", "healthy simulator state confirmed during startup reconciliation after repair intent");
        this.store.recordAudit({ actorUsername: "system", action: "maintenance.reconciled", target: job.component,
          details: { job_id: job.id, command_id: repairAttempt?.id ?? null, result: "healthy" } });
      } else {
        target.maintenance = true;
        if (job.component_type === "gate") (target as Gate).draining = true;
        if (job.status === "requested" && repairAttempt) this.store.updateMaintenanceJob(job.id, "in_progress",
          "repair was already attempted before restart; duplicate command suppressed pending simulator confirmation");
        if (repairAttempt?.status === "outcome_unknown") this.store.createOrUpdateIncident({ type: "repair_outcome_unknown",
          correlationKey: job.id, severity: "high", summary: `Repair result for ${job.component} is unknown; do not submit another repair`,
          component: job.component, componentType: job.component_type, zone: job.zone,
          details: { job_id: job.id, command_id: repairAttempt.id, command_status: repairAttempt.status } });
      }
    }
  }

  private reset() {
    for (const t of this.timers) t.done = true; // their setTimeouts may still fire
    this.spots = new Map();
    this.gates = new Map();
    this.cars = new Map();
    this.timers = [];
    this.entryLanes = new Map();
    this.exitLanes = new Map();
    this.environmentDiscoveryAttempted = false;
    this.fanInventoryAvailable = false;
    this.fanInventoryComplete = false;
    this.exhaustFans.clear();
    this.lights.clear();
    this.fanBrokenOverrides.clear();
    this.fanMaintenanceOverrides.clear();
    this.componentSequences.clear();
    for (const gate of this.gates.values()) {
      gate.draining = false;
      gate.drainCloseRetries = 0;
    }
  }

  /**
   * Rebuild state after a restart: recent webhooks AND the commands we sent, merged in time
   * order. Events go through the handlers (what happened); our own decisions are taken from
   * the recorded commands (where a car was sent, what it was charged, when it was released),
   * never re-made - replaying events alone forgot every charge, so cars that had already
   * paid were billed again ("Car has already paid for parking").
   */
  async replay(): Promise<void> {
    const since = Date.now() - this.cfg.replayWindowS * 1000;
    const events = this.store.eventsSince(since);
    const newest = events.reduce((m, r) => Math.max(m, tsOf(r._received_at) ?? 0), 0);
    if (nowS() - newest > this.cfg.replayMaxGapS) {
      this.log.info(`event log is ${newest ? `${Math.round(nowS() - newest)}s` : "empty/too"} old - ` +
        "simulator likely restarted since; starting fresh");
      return;
    }
    const actions = this.store.actionsSince(since).filter((a) => a.ok && (a.cmd === "goto" || a.cmd === "charge"));
    const timeline = [
      ...events.map((e) => ({ t: tsOf(e._received_at) ?? 0, event: e as EventRecord | null, action: null as ActionRecord | null })),
      ...actions.map((a) => ({ t: tsOf(a.at) ?? 0, event: null, action: a })),
    ].sort((a, b) => a.t - b.t);
    this.replaying = true;
    try {
      for (const item of timeline) {
        if (item.event) await this.handle(item.event);
        else this.applyRecordedAction(item.action!);
      }
    } finally {
      this.replaying = false;
    }
    this.log.info(`replayed ${events.length} events and ${actions.length} commands`);
  }

  /** Re-apply a decision we made before the restart, exactly as it was made. */
  private applyRecordedAction(a: ActionRecord) {
    const plate = a.args[0];
    const car = this.cars.get(plate);
    if (!car) return;
    const t = this.clock.gameAt(tsOf(a.at));
    if (a.cmd === "charge") { // args: plate, parkingCost, chargingCost
      const savedInvoice = car.visit_id ? this.store.latestInvoice(car.visit_id) : undefined;
      if (savedInvoice && savedInvoice.status !== "rejected" && savedInvoice.status !== "superseded") {
        this.applyInvoice(car, savedInvoice);
      } else {
        car.charge_parking = Number(a.args[1]);
        car.charge_electric = Number(a.args[2]) || 0;
        car.invoice_status = "issued";
      }
      car.charge_attempts++;
      if (!["released", "payment_mismatch", "gone"].includes(car.status)) car.status = "invoiced";
      return;
    }
    const target = a.args[1]; // goto args: plate, destination
    const lane = car.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
    const notYetIn = car.status === "queued" || car.status === "dispatching";
    if (target === Destination.LeavePark) {
      if (notYetIn) { // turned away at the entry
        if (lane) lane.queue = lane.queue.filter((p) => p !== plate);
        car.status = "turned_away";
        car.gotoG = t;
        this.counters.turned_away++;
      } else { // released at an exit
        car.status = "released";
        car.releasedG = car.gotoG = t;
        if (car.exit_lane) {
          const exit = this.exitLanes.get(car.exit_lane);
          if (exit) {
            exit.queue = exit.queue.filter((p) => p !== plate);
            exit.passageOwner = plate;
            exit.passageState = "released";
            exit.releasing.add(plate);
          }
        }
      }
    } else if (target !== Destination.Exit) { // sent to a parking spot
      if (lane) {
        lane.queue = lane.queue.filter((p) => p !== plate);
        if (notYetIn || car.status === "dispatched") lane.current = plate;
      }
      const previous = car.spot ? this.spots.get(car.spot) : undefined;
      if (previous?.reserved_for === plate) previous.reserved_for = null;
      const spot = this.spots.get(target);
      if (spot && !spot.occupants.has(plate)) spot.reserved_for = plate;
      car.spot = target;
      if (notYetIn) { car.status = "dispatched"; this.counters.admitted++; }
      car.dispatchedG = car.gotoG = t;
    }
  }

  /** Make replayed/remembered state agree with what the sensors report right now.
   * startup=false (a live resync) leaves lanes alone: a car may be mid-dispatch. */
  async reconcile(startup = true): Promise<void> {
    if (startup) this.reconcileLanes();
    for (const s of this.spots.values()) {
      if (s.purpose !== SpotPurpose.Park) continue;
      if (s.detected && !s.occupants.size && !s.manualOccupancy) {
        s.occupants.add("?");
      }
      if (this.cfg.webhookProfile === "level2") {
        const knownOccupants = Math.max(s.occupants.size, s.manualOccupancy ? 1 : 0);
        if (s.detected !== knownOccupants) {
          this.store.createOrUpdateIncident({ type: "occupancy_evidence_conflict", correlationKey: s.name, severity: "high",
            summary: `${s.name} occupancy history conflicts with the live detector; the spot remains unavailable`,
            component: s.name, componentType: "spot", zone: s.zone,
            details: { detected_count: s.detected, known_occupants: [...s.occupants], manual_occupancy: s.manualOccupancy,
              resolution: "reconcile the visit or record an audited physical-clearance observation" } });
        } else {
          this.store.resolveIncidentByCorrelation("occupancy_evidence_conflict", s.name, "system",
            "live detector count now matches the retained occupancy history");
        }
        // A zero count may be stale or may follow a lost CarOut webhook. Retain every
        // replayed occupant/reservation until trusted movement evidence or review resolves it.
        continue;
      }
      if (!s.detected && s.occupants.size) {
        for (const p of s.occupants) {
          const car = this.cars.get(p);
          if (car && car.status === "parked") this.cars.delete(car.plate);
        }
        s.occupants.clear();
      }
    }
    for (const car of [...this.cars.values()]) {
      const sensor = car.exit_lane ? this.spots.get(car.exit_lane) : undefined;
      if (AT_EXIT.includes(car.status) && !sensor?.detected) this.cars.delete(car.plate);
      else if (car.status === "at_exit" && car.exit_lane) {
        const lane = this.exitLanes.get(car.exit_lane);
        if (lane && !lane.queue.includes(car.plate)) lane.queue.push(car.plate);
        if (lane?.passageOwner === car.plate) this.scheduleCharge(car.plate, this.cfg.exitChargeDelayGameS);
      }
      else if (car.status === "released") await this.release(car);
      else if (DEAD.includes(car.status)) {
        const heldUncertain = this.cfg.webhookProfile === "level2" && car.status === "unknown" && (
          (car.exit_lane !== null && this.exitLanes.get(car.exit_lane)?.passageOwner === car.plate) ||
          (car.spot !== null && this.spots.get(car.spot)?.reserved_for === car.plate));
        if (!heldUncertain) this.cars.delete(car.plate);
      }
    }
    if (startup) for (const lane of this.exitLanes.values()) {
      // The visit is removed when its exit sensor reports CarOut, but the gate still
      // needs a physical-clearance delay. That timer is process-local, so rebuild it
      // after replay before allowing the next paid vehicle through this lane.
      if (lane.passageOwner !== null && lane.passageState === "clearing") {
        this.scheduleExitPassageClose(lane, lane.passageOwner);
      }
      await this.advanceExitLane(lane);
    }
  }

  private reconcileLanes() {
    const now = this.clock.now();
    // A car sent to a spot just before a restart is still driving there: keep its
    // reservation. (Clearing it let the next car be sent to the same spot - two cars in
    // one spot, and a fine for every car sent there after.)
    const onTheWay = (plate: string | null) => {
      const car = plate ? this.cars.get(plate) : undefined;
      return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering" || (car.status === "unknown" && car.spot !== null));
    };
    for (const s of this.spots.values()) {
      if (s.reserved_for && (!onTheWay(s.reserved_for) || this.cars.get(s.reserved_for)?.spot !== s.name)) s.reserved_for = null;
    }
    for (const lane of this.entryLanes.values()) {
      const sensor = this.spots.get(lane.spot);
      if (lane.current && !onTheWay(lane.current)) lane.current = null;
      lane.queue = lane.queue.filter((plate) => {
        const car = this.cars.get(plate);
        const alive = !!car && !!sensor?.detected && car.arrivedG !== null &&
          now - car.arrivedG < this.cfg.entryPatienceGameS;
        if (!alive) this.cars.delete(plate);
        return alive;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // event routing
  // ---------------------------------------------------------------------------
  async handle(e: EventRecord): Promise<void> {
    if (e.EventClass === EventClass.CarbonMonoxide && e._accepted !== true) return;
    // Events that arrived during startup are both in the replayed log and in the live
    // queue; process each only once.
    const eid = e.EventId;
    if (this.replaying) {
      if (eid) this.replayedIds.add(eid);
    } else {
      if (eid && this.replayedIds.has(eid)) return;
      this.clock.activity(); // the game is running (not paused)
      const now = nowS();
      if (this.lastEventReal && now - this.lastEventReal > this.real(this.cfg.resyncAfterSilenceGameS)) {
        // The simulator was probably restarted or reloaded while we kept running.
        this.maybeResync(`no events for ${Math.round(now - this.lastEventReal)}s`);
      }
      this.lastEventReal = now;
    }

    switch (e.EventClass) {
      case EventClass.CarSpotAction: await this.routeCarEvent(e); break;
      case EventClass.GateAction: await this.onGate(e); break;
      case EventClass.PaymentMade: await this.onPayment(e); break;
      case EventClass.ComponentBroken: await this.onComponent(e, true); break;
      case EventClass.ComponentFixed: await this.onComponent(e, false); break;
      case EventClass.CarbonMonoxide: await this.onCarbonMonoxide(e); break;
      case EventClass.Penalty: await this.onPenalty(e); break;
    }
    // Stale-record detection (sweepGhosts) measures silence from here.
    const car = this.cars.get(str(e, "CarPlateNumber") ?? "");
    if (car) {
      car.state_version = (car.state_version ?? 0) + 1;
      car.lastSeenG = this.gameAt(e);
      this.store.saveVisitState(publicCar(car));
    }
  }

  private async routeCarEvent(e: EventRecord): Promise<void> {
    const name = str(e, "SpotName") ?? "", spotType = str(e, "SpotType");
    const carIn = str(e, "Direction") === Direction.In;
    const entry = this.entryLanes.get(name), exit = this.exitLanes.get(name);
    if (entry) return carIn ? this.onEntryIn(e, entry) : this.onEntryOut(e, entry);
    if (exit) return carIn ? this.onExitIn(e, exit) : this.onExitOut(e, exit);
    if (spotType === SpotPurpose.Park) return carIn ? this.onSpotIn(e) : this.onSpotOut(e);
    if ((spotType === SpotPurpose.Entry || spotType === SpotPurpose.Exit) && !this.replaying) {
      return this.handleUnknownLaneEvent(e, name, spotType);
    }
  }

  /**
   * An event from an entry/exit we don't know: the level was loaded (or switched) after
   * our last sync. Reload the layout right now and handle this same event - queueing a
   * resync behind it would drop it, and with it the first car of every level.
   */
  private async handleUnknownLaneEvent(e: EventRecord, name: string, spotType: string): Promise<void> {
    const last = this.unresolvedSpots.get(name) ?? 0;
    if (nowS() - last < 10) return; // already reloaded for this spot moments ago; it isn't in the layout
    this.unresolvedSpots.set(name, nowS());
    this.note("warn", `event from unknown ${spotType} ${name} - reloading layout now`);
    try {
      await this.sync();
    } catch (err) {
      this.note("error", `layout reload failed: ${(err as Error).message}`);
      return;
    }
    if (this.entryLanes.has(name) || this.exitLanes.has(name)) {
      this.unresolvedSpots.delete(name);
      return this.routeCarEvent(e);
    }
    this.note("warn", `${spotType} ${name} is not part of the loaded layout - event ignored`);
  }

  /** An entry/exit we don't know, or a long silence, means the layout may have
   * changed: reload it (rate-limited). */
  private maybeResync(why: string) {
    if (nowS() - this.lastResyncRequest > 10) {
      this.lastResyncRequest = nowS();
      this.note("warn", `${why} - resyncing`);
      this.requestResync();
    }
  }

  // ---------------------------------------------------------------------------
  // entry
  // ---------------------------------------------------------------------------
  private async onEntryIn(e: EventRecord, lane: EntryLane) {
    const plate = str(e, "CarPlateNumber")!;
    const stale = this.cars.get(plate);
    if (stale) {
      if ([...this.entryLanes.values()].some((l) => l.queue.includes(plate) || l.current === plate)) {
        return; // repeated sensor event for a car already being handled
      }
      // A car at an entry is outside the car park, so any other record for this plate
      // is stale (plates are reused, e.g. after a simulator restart).
      this.note("warn", `${plate} arrived at ${lane.spot} while recorded as '${stale.status}' - replacing stale record`);
      this.forget(stale);
    }
    const car = newCar(plate, str(e, "CarType") || CarType.Normal, toInt(e.PlannedParkingDurationInMinutes), "queued", {
      visit_id: this.store.getOrCreateVisitId(str(e, "EventId") ?? null, plate, e.ServerDateTime, true),
      entry_lane: lane.spot, arrived_at: e.ServerDateTime ?? null, arrivedG: this.gameAt(e),
    });
    this.cars.set(plate, car);
    this.counters.arrived++;
    this.recentPaid.delete(plate); // came in through an entry: a new visit, billed normally
    if (this.replaying) { // what happened next is in the recorded commands
      lane.queue.push(plate);
      return;
    }
    if (lane.gate && this.gates.get(lane.gate)?.draining) return this.turnAway(car, `entry lane is draining for maintenance on ${lane.gate}`);
    if (this.coStates.get(lane.zone)?.restricted) return this.turnAway(car, `CO safety restriction is active in ${lane.zone}`);
    if (lane.closed) return this.turnAway(car, `entrance ${lane.spot} is closed`);

    // Spots are reserved at dispatch time, so every car already queued for the same
    // pool of spots still needs one.
    const free = this.allocator.candidates(car.car_type, lane.zone, this.spots.values()).length;
    const waiting = [...this.entryLanes.values()]
      .filter((l) => this.allocator.sharesPool(l.zone, lane.zone))
      .reduce((n, l) => n + l.queue.length, 0);
    if (free - waiting <= 0) return this.turnAway(car, "no free spot");
    lane.queue.push(plate);
    this.note("info", `${plate} arrived at ${lane.spot} (${car.car_type}, planned ${car.planned_minutes}m), queue=${lane.queue.length}`);
    await this.pumpEntry(lane);
  }

  /** Dispatch the head of the lane's queue if the lane is free. */
  async pumpEntry(lane: EntryLane): Promise<void> {
    if (this.replaying || lane.current || !lane.queue.length) return; // replay: decisions come from the log
    // High/Critical CO suspends new admissions but lets an already-authorized crossing
    // finish. Cars waiting behind it remain queued until a verified recovery check.
    if (this.coStates.get(lane.zone)?.restricted) return;
    const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
    if (lane.gate && (!gate || !gate.operable || gate.draining)) return; // held until repair/drain finishes
    const plate = lane.queue.shift()!;
    const car = this.cars.get(plate)!;
    const spot = this.allocator.choose(car.car_type, lane.zone, this.spots.values());
    if (!spot) {
      await this.turnAway(car, "no suitable spot");
      return this.pumpEntry(lane);
    }
    spot.reserved_for = plate;
    car.spot = spot.name;
    car.status = "dispatching";
    car.dispatchedG = this.clock.now();
    car.gotoResends = 0;
    lane.current = plate;
    const send = () => this.sendToSpot(plate, lane);
    if (gate) await this.whenGateOpen(gate, send);
    else await send();
  }

  private async sendToSpot(plate: string, lane: EntryLane) {
    const car = this.cars.get(plate);
    if (!car || lane.current !== plate || !car.spot) return;
    if (await this.cmd("goto", () => this.sim.carGoto(plate, car.spot!), [plate, car.spot])) {
      car.gotoG = this.clock.now();
      if (car.status !== "dispatching") return; // a re-send (checkStuckGotos)
      car.status = "dispatched";
      car.dispatchedG = car.gotoG;
      this.counters.admitted++;
      this.note("info", `${plate} -> ${car.spot}`);
    }
  }

  private async onEntryOut(e: EventRecord, lane: EntryLane) {
    const plate = str(e, "CarPlateNumber")!;
    const car = this.cars.get(plate);
    if (car?.spot) this.store.confirmCommandIntent("goto", [plate, car.spot]);
    if (plate === lane.current) {
      if (car) car.status = "entering";
      lane.current = null;
      if (lane.queue.length) await this.pumpEntry(lane);
      else this.later(this.cfg.gateCloseDelayGameS, `close ${lane.gate}`, () => this.closeGateIfIdle(lane.gate));
    } else if (lane.queue.includes(plate)) {
      lane.queue.splice(lane.queue.indexOf(plate), 1);
      car!.status = "neglected";
      this.counters.neglected++;
      this.note("warn", `${plate} gave up waiting at ${lane.spot}`);
      this.finish(car!, e);
    } else if (car?.status === "turned_away") {
      this.finish(car, e);
    }
  }

  private async turnAway(car: Car, reason: string) {
    car.status = "turned_away";
    this.counters.turned_away++;
    this.note("warn", `${car.plate} turned away: ${reason}`);
    await this.leavePark(car);
  }

  /** Send a car out of the car park (turned away at an entry, or released at an exit). */
  private async leavePark(car: Car) {
    if (await this.cmd("goto", () => this.sim.carGoto(car.plate, Destination.LeavePark), [car.plate, Destination.LeavePark])) {
      car.gotoG = this.clock.now();
    }
  }

  // ---------------------------------------------------------------------------
  // parking spots
  // ---------------------------------------------------------------------------
  private async onSpotIn(e: EventRecord) {
    const plate = str(e, "CarPlateNumber")!, name = str(e, "SpotName")!;
    this.store.confirmCommandIntent("goto", [plate, name]);
    let spot = this.spots.get(name);
    if (!spot) this.spots.set(name, (spot = new Spot(name, "", SpotPurpose.Park, CarType.Any)));
    // Another car already in this spot does NOT mean it left: the simulator lets a second
    // car park on top (and fines it). Both stay recorded until each one's CarOut.
    const others = [...spot.occupants].filter((p) => p !== plate && p !== "?");
    if (others.length) this.note("error", `${plate} parked in ${name}, which still holds ${others.join(", ")}`);
    const car = this.cars.get(plate) ?? this.adopt(e);
    if (car.spot && car.spot !== name) {
      this.note("warn", `${plate} parked in ${name}, was sent to ${car.spot}`);
      const other = this.spots.get(car.spot);
      if (other?.reserved_for === plate) other.reserved_for = null;
    }
    if (spot.reserved_for === plate) spot.reserved_for = null;
    spot.occupants.add(plate);
    car.spot = name;
    car.status = "parked";
    car.parked_at = e.ServerDateTime ?? null;
    car.parkedG = this.gameAt(e);
    car.parkedA = this.activeAt(e);
    car.planned_minutes = toInt(e.PlannedParkingDurationInMinutes) || car.planned_minutes;
    const lane = car.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
    if (lane && lane.current === plate) { // parked without an entry CarOut we saw
      lane.current = null;
      await this.pumpEntry(lane);
    }
    this.note("info", `${plate} parked in ${name}`);
  }

  private async onSpotOut(e: EventRecord) {
    const plate = str(e, "CarPlateNumber")!, name = str(e, "SpotName")!;
    const spot = this.spots.get(name);
    if (spot) {
      if (spot.occupants.has(plate)) spot.occupants.delete(plate);
      else spot.occupants.delete("?"); // the car we could not name has left
    }
    const car = this.cars.get(plate) ?? this.adopt(e);
    car.left_spot_at = e.ServerDateTime ?? null;
    car.leftSpotG = this.gameAt(e);
    car.leftSpotA = this.activeAt(e);
    // A car stays exactly its planned game minutes: planned / measured real time is the
    // game speed, learned without it having to be configured anywhere.
    this.clock.addStay(car.planned_minutes, car.parkedA, car.leftSpotA);
    // Only advance the state. From a spot right next to an exit (S15 on Level 1) the
    // exit CarIn arrives ~0.2s BEFORE this CarOut; overwriting "at_exit" here would
    // cancel the pending charge and the car escapes unpaid.
    if (car.status === "parked" || car.status === "unknown") car.status = "to_exit";
    this.note("info", `${plate} left ${name}`);
    for (const lane of this.entryLanes.values()) await this.pumpEntry(lane); // a spot just freed up
  }

  // ---------------------------------------------------------------------------
  // exit & payment
  // ---------------------------------------------------------------------------
  /**
   * Spots beyond the exit sensor (S15, S30 on Level 1) are reached by driving over it: a
   * car on its way IN fires exit CarIn/CarOut and parks in the same second. Treating that
   * as leaving closed its record ("left without being released"), so its real exit later
   * looked like a paid car looping and it was let out unbilled - an escape penalty.
   */
  private drivingIn(plate: string): boolean {
    const car = this.cars.get(plate);
      return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering" || (car.status === "unknown" && car.spot !== null));
  }

  private async onExitIn(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    if (this.drivingIn(plate)) {
      return;
    }
    const exitSensor = this.spots.get(lane.spot);
    if (exitSensor) exitSensor.detected = Math.max(1, exitSensor.detected);
    const car = this.cars.get(plate) ?? this.adopt(e);
    car.exit_lane = lane.spot;
    car.exit_at = e.ServerDateTime ?? null;
    // A car at the exit is no longer in its spot, whether or not we saw it leave. (From a
    // spot next to the exit the spot CarOut simply arrives ~0.2s later; if it was lost,
    // this is what frees the spot.)
    const held = car.spot ? this.spots.get(car.spot) : undefined;
    if (held?.occupants.has(plate)) {
      held.occupants.delete(plate);
      for (const l of this.entryLanes.values()) await this.pumpEntry(l);
    }
    const savedInvoice = car.visit_id ? this.store.activeInvoice(car.visit_id) : undefined;
    if (savedInvoice && car.invoice_id !== savedInvoice.id) this.applyInvoice(car, savedInvoice);
    const measuredStay = car.parked_at !== null && car.left_spot_at !== null;
    if (car.entry_lane === null && !this.recentPaid.has(plate) && !measuredStay && car.charge_parking === null) {
      this.holdUnknownVisit(car, lane, "no trusted entry or parking history is available");
      return;
    }
    if (car.charge_parking !== null) return; // already invoiced: charging twice is a penalty
    if (car.entry_lane === null && this.recentPaid.has(plate)) {
      // Paid moments ago and never came back through an entry: the same session looping
      // (seen with cars restored from a simulator save), not a new one.
      this.counters.repeat_exits++;
      this.note("warn", `${plate} back at ${lane.spot} after paying, without entering - not billing again, releasing`);
      car.payment_ok = true;
      if (!lane.queue.includes(plate) && lane.passageOwner !== plate) lane.queue.push(plate);
      await this.advanceExitLane(lane);
      if (lane.passageOwner === plate) await this.release(car);
      return;
    }
    car.status = "at_exit";
    if (!lane.queue.includes(plate) && lane.passageOwner !== plate) lane.queue.push(plate);
    await this.advanceExitLane(lane);
    if (lane.passageOwner === plate && car.payment_ok) await this.release(car);
  }

  private applyInvoice(car: Car, invoice: import("@gpa/shared").InvoiceView) {
    car.invoice_id = invoice.id;
    car.charge_parking = invoice.parking_minor / 100;
    car.charge_electric = invoice.electricity_minor / 100;
    car.billing_basis = invoice.billing_basis;
    car.invoice_status = invoice.status;
    if (invoice.status !== "rejected" && invoice.status !== "waived" && !["released", "gone"].includes(car.status)) car.status = "invoiced";
  }

  private holdUnknownVisit(car: Car, lane: ExitLane, reason: string) {
    car.status = "unknown";
    car.exit_lane = lane.spot;
    if (!lane.queue.includes(car.plate)) lane.queue.push(car.plate);
    if (lane.passageOwner === null) {
      lane.passageOwner = car.plate;
      lane.passageState = "uncertain";
    }
    this.store.createOrUpdateIncident({ type: "unknown_visit", correlationKey: car.plate, severity: "high",
      summary: `Parking history for ${car.plate} cannot be trusted; billing and release are on hold`, plate: car.plate,
      lane: lane.spot, details: { visit_id: car.visit_id ?? null, reason } });
    this.note("error", `${car.plate} at ${lane.spot} has unknown visit history; no charge or release will be issued`);
  }

  /** Operator-supplied duration is evidence, not a free-form price override. */
  async reviewUnknownDuration(plate: string, expectedVersion: number, minutes: number, reason: string, actor: string): Promise<ControlResult> {
    const car = this.cars.get(plate);
    if (!car || car.status !== "unknown") return fail("no active unknown visit for that plate");
    if ((car.state_version ?? 0) !== expectedVersion) return fail("visit changed since it was loaded; refresh and retry with the current version");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return fail("duration must be a whole number of minutes between 1 and 1440");
    if (reason.trim().length < 8) return fail("review reason must be at least 8 characters");
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (!lane || lane.passageOwner !== plate || lane.passageState !== "uncertain") return fail("visit is not the held passage owner");
    const incident = this.store.getIncidentByCorrelation("unknown_visit", plate);
    if (!incident) return fail("unknown-visit evidence record is missing");
    car.approved_duration_minutes = minutes;
    car.state_version = (car.state_version ?? 0) + 1;
    car.billing_basis = `operator-approved duration ${minutes}m`;
    car.status = "at_exit";
    lane.passageState = "waiting_payment";
    this.store.updateIncident(incident.id, "acknowledged", actor, reason.trim());
    this.store.recordAudit({ actorUsername: actor, action: "visit.duration_reviewed", target: car.visit_id ?? plate,
      reason: reason.trim(), details: { plate, minutes, invoice_to_follow: true } });
    this.note("warn", `${actor} approved ${minutes} minutes of parking history for ${plate}; normal tariff will apply`);
    this.store.saveVisitState(publicCar(car));
    this.scheduleCharge(plate, this.cfg.exitChargeDelayGameS);
    return ok(`duration review recorded for ${plate}; normal invoice will be issued`);
  }

  /** Release a quarantined destination only after a one-shot, fresh simulator count proves it empty. */
  async reviewUncertainReservation(visitId: string, requestId: string, expectedVersion: number, reason: string, actor: string): Promise<ControlResult> {
    if (!requestId.trim() || reason.trim().length < 8) return fail("request ID and reason of at least 8 characters are required");
    const previous = this.store.auditRequestResult("visit.reservation.review", requestId);
    if (previous) return previous === "cleared"
      ? ok(`reservation review ${requestId} was already completed`)
      : fail(`reservation review ${requestId} previously found the spot was not safely clear`);
    const car = [...this.cars.values()].find((candidate) => candidate.visit_id === visitId);
    if (!car) return fail("visit is no longer active; refresh and review the incident history");
    if ((car.state_version ?? 0) !== expectedVersion) return fail("visit changed since it was loaded; refresh and retry with the current version");
    const spot = car.spot ? this.spots.get(car.spot) : undefined;
    if (!spot || car.status !== "unknown" || spot.reserved_for !== car.plate) return fail("visit does not own an uncertain spot reservation");
    if (!this.store.getIncidentByCorrelation("uncertain_reservation", visitId)) return fail("uncertain-reservation incident is missing");
    if (this.store.activeMaintenanceJob("spot", spot.name)) return fail(`${spot.name} has an active maintenance job; reconcile that job first`);

    let liveSpot: SimParkingSpot | undefined;
    try {
      liveSpot = (await this.sim.listParkingSpots()).find((candidate) => candidate.name === spot.name);
    } catch (error) {
      this.store.recordAudit({ actorUsername: actor, action: "visit.reservation.review", target: visitId, reason: reason.trim(),
        details: { request_id: requestId, result: "held", error: (error as Error).message } });
      return fail("fresh simulator occupancy could not be read; reservation remains quarantined");
    }
    if (!liveSpot || !Number.isInteger(liveSpot.detectedCars) || liveSpot.detectedCars < 0) {
      this.store.recordAudit({ actorUsername: actor, action: "visit.reservation.review", target: visitId, reason: reason.trim(),
        details: { request_id: requestId, result: "held", detector_count: liveSpot?.detectedCars ?? null } });
      return fail("simulator did not provide an unambiguous occupancy count; reservation remains quarantined");
    }
    spot.detected = liveSpot.detectedCars;
    if (liveSpot.broken || liveSpot.isUnderMaintenance || liveSpot.detectedCars !== 0 || spot.occupants.size > 0) {
      this.store.createOrUpdateIncident({ type: "uncertain_reservation", correlationKey: visitId, severity: "high",
        summary: `${car.plate}'s destination ${spot.name} remains quarantined after an occupancy check`, plate: car.plate,
        component: spot.name, componentType: "spot", zone: spot.zone, lane: car.entry_lane,
        details: { visit_id: visitId, spot: spot.name, detector_count: liveSpot.detectedCars, known_occupants: [...spot.occupants],
          broken: liveSpot.broken, under_maintenance: liveSpot.isUnderMaintenance, request_id: requestId } });
      this.store.recordAudit({ actorUsername: actor, action: "visit.reservation.review", target: visitId, reason: reason.trim(),
        details: { request_id: requestId, result: "held", detector_count: liveSpot.detectedCars, known_occupants: [...spot.occupants] } });
      return fail(`${spot.name} is not confirmed clear; reservation remains quarantined`);
    }

    spot.broken = false;
    spot.maintenance = false;
    spot.reserved_for = null;
    car.state_version = (car.state_version ?? 0) + 1;
    this.store.resolveIncidentByCorrelation("uncertain_reservation", visitId, actor, `Fresh simulator detector showed the destination empty: ${reason.trim()}`);
    this.store.recordAudit({ actorUsername: actor, action: "visit.reservation.review", target: visitId, reason: reason.trim(),
      details: { request_id: requestId, result: "cleared", spot: spot.name, detector_count: liveSpot.detectedCars } });
    this.retire(car, `was confirmed absent from reserved spot ${spot.name} during operator review`, "lost");
    const entry = car.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
    if (entry) await this.pumpEntry(entry);
    return ok(`reservation at ${spot.name} was released after a fresh empty-sensor check; visit recorded as unresolved/lost`);
  }

  adminApplyFinancialAdjustment(visitId: string, requestId: string, expectedVersion: number, amount: number, reason: string, actor: string): ControlResult {
    if (!requestId.trim() || reason.trim().length < 8) return fail("request ID and reason of at least 8 characters are required");
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.005 || Math.abs(amount) > 1_000_000) return fail("adjustment must be a nonzero finite amount within the supported limit");
    const existing = this.store.financialAdjustmentByRequestId(requestId);
    if (existing) return existing.visit_id === visitId && existing.kind === "adjustment"
      ? ok(`adjustment ${existing.id} was already recorded`) : fail("request ID was already used for another financial action");
    const session = this.store.sessionByVisitId(visitId);
    if (!session || session.payment_ok !== true) return fail("financial adjustments are limited to completed visits with verified payment");
    if ((session.state_version ?? 0) !== expectedVersion) return fail("visit changed since it was loaded; refresh and retry with the current version");
    const invoice = this.store.latestInvoice(visitId);
    this.store.recordFinancialAdjustment({ requestId, visitId, invoiceId: invoice?.id, plate: session.plate,
      kind: "adjustment", amountMinor: Math.round(amount * 100), reason, actor });
    this.store.recordAudit({ actorUsername: actor, action: "visit.financial_adjustment", target: visitId, reason: reason.trim(),
      details: { amount_minor: Math.round(amount * 100), invoice_id: invoice?.id ?? null, request_id: requestId } });
    return ok(`financial adjustment recorded for ${visitId}; simulator payment is unchanged`);
  }

  async adminWaiveVisit(visitId: string, requestId: string, expectedVersion: number, reason: string, actor: string): Promise<ControlResult> {
    if (!requestId.trim() || reason.trim().length < 8) return fail("request ID and reason of at least 8 characters are required");
    const existing = this.store.financialAdjustmentByRequestId(requestId);
    if (existing) return existing.visit_id === visitId && existing.kind === "waiver"
      ? ok(`waiver ${existing.id} was already recorded`) : fail("request ID was already used for another financial action");
    const car = [...this.cars.values()].find((candidate) => candidate.visit_id === visitId);
    if (!car) return fail("visit is not active; use a financial adjustment for a completed visit");
    if ((car.state_version ?? 0) !== expectedVersion) return fail("visit changed since it was loaded; refresh and retry with the current version");
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (!lane || lane.passageOwner !== car.plate || !["unknown", "at_exit", "invoiced", "payment_mismatch"].includes(car.status)) {
      return fail("waiver is available only for the active held exit visit");
    }
    const latest = this.store.latestInvoice(visitId);
    if (this.store.activeInvoice(visitId) || latest?.status === "settled") {
      return fail("an invoice may already have been accepted or paid; reconcile it before waiving");
    }
    let invoice: import("@gpa/shared").InvoiceView;
    try {
      invoice = this.store.createInvoice({ visitId, plate: car.plate, parking: 0, electricity: 0, billingBasis: `admin waiver: ${reason.trim()}` });
      this.store.updateInvoiceStatus(invoice.id, "waived");
    } catch (error) {
      return fail(`could not persist waiver invoice: ${(error as Error).message}`);
    }
    this.store.recordFinancialAdjustment({ requestId, visitId, invoiceId: invoice.id, plate: car.plate,
      kind: "waiver", amountMinor: 0, reason, actor });
    this.store.recordAudit({ actorUsername: actor, action: "visit.waived", target: visitId, reason: reason.trim(),
      details: { invoice_id: invoice.id, request_id: requestId, previous_invoice_id: latest?.id ?? null } });
    car.invoice_id = invoice.id;
    car.state_version = (car.state_version ?? 0) + 1;
    car.invoice_status = "waived";
    car.charge_parking = car.charge_electric = 0;
    car.paid = 0;
    car.payment_ok = true;
    car.status = "at_exit";
    lane.passageState = "waiting_payment";
    this.store.saveVisitState(publicCar(car));
    this.store.resolveIncidentByCorrelation("unknown_visit", car.plate, actor, `Admin waiver approved: ${reason.trim()}`);
    this.note("warn", `${actor} waived invoice for ${car.plate} (${visitId}): ${reason.trim()}`);
    await this.release(car);
    return ok(`waiver recorded; authorized exit passage started for ${car.plate}`);
  }

  async adminEmergencyRelease(visitId: string, requestId: string, expectedVersion: number, reason: string, actor: string): Promise<ControlResult> {
    if (!requestId.trim() || reason.trim().length < 8) return fail("request ID and reason of at least 8 characters are required");
    const existing = this.store.financialAdjustmentByRequestId(requestId);
    if (existing) return existing.visit_id === visitId && existing.kind === "emergency_release"
      ? ok(`emergency release ${existing.id} was already recorded`) : fail("request ID was already used for another financial action");
    const car = [...this.cars.values()].find((candidate) => candidate.visit_id === visitId);
    if (!car) return fail("visit is not active");
    if ((car.state_version ?? 0) !== expectedVersion) return fail("visit changed since it was loaded; refresh and retry with the current version");
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (!lane || lane.passageOwner !== car.plate || ["released", "gone"].includes(car.status)) return fail("visit does not own a releasable exit passage");
    const sensor = this.spots.get(lane.spot);
    if (!sensor || sensor.detected < 1) return fail("exit presence is not confirmed; reconcile the vehicle location before emergency release");
    const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
    if (lane.gate && (!gate || !gate.operable)) return fail("exit gate is unavailable; repair or recover the gate before emergency release");
    const invoice = this.store.latestInvoice(visitId);
    this.store.recordFinancialAdjustment({ requestId, visitId, invoiceId: invoice?.id, plate: car.plate,
      kind: "emergency_release", amountMinor: 0, reason, actor });
    this.store.recordAudit({ actorUsername: actor, action: "visit.emergency_release", target: visitId, reason: reason.trim(),
      details: { invoice_id: invoice?.id ?? null, request_id: requestId, payment_ok: car.payment_ok } });
    this.store.createOrUpdateIncident({ type: "admin_emergency_release", correlationKey: requestId, severity: "high",
      summary: `Admin authorized emergency release for ${car.plate}`, plate: car.plate, lane: lane.spot,
      details: { visit_id: visitId, invoice_id: invoice?.id ?? null, payment_ok: car.payment_ok, reason: reason.trim() } });
    car.status = "at_exit";
    car.state_version = (car.state_version ?? 0) + 1;
    lane.passageState = "waiting_payment";
    this.store.saveVisitState(publicCar(car));
    this.note("error", `${actor} authorized emergency release for ${car.plate} (${visitId}): ${reason.trim()}`);
    await this.release(car);
    return ok(`emergency release audited; gate authorization started for ${car.plate}`);
  }

  /** Only the queue head may be invoiced or own the gate's current passage. */
  private async advanceExitLane(lane: ExitLane): Promise<void> {
    if (lane.passageOwner !== null || lane.passageState === "uncertain" || lane.passageState === "closing") return;
    const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
    if (gate?.draining) return; // leave later vehicles queued until this gate is repaired
    while (lane.queue.length) {
      const plate = lane.queue[0];
      const car = this.cars.get(plate);
      if (!car || car.exit_lane !== lane.spot || !["at_exit", "invoiced", "payment_mismatch", "released", "unknown"].includes(car.status)) {
        lane.queue.shift();
        continue;
      }
      lane.passageOwner = plate;
      lane.passageState = car.status === "unknown" ? "uncertain" : "waiting_payment";
      if (!car.payment_ok && car.status === "at_exit" && car.charge_parking === null && !this.replaying) {
        // The exit sensor must settle before charge is accepted by the simulator.
        this.scheduleCharge(plate, this.cfg.exitChargeDelayGameS);
      }
      return;
    }
    lane.passageState = "idle";
  }

  scheduleCharge(plate: string, delayGameS: number): void {
    const car = this.cars.get(plate);
    if (this.replaying || !car || car.chargeScheduled) return; // after a replay, reconcile() reschedules
    car.chargeScheduled = true;
    this.later(delayGameS, `charge ${plate}`, () => this.charge(plate));
  }

  private async charge(plate: string) {
    const car = this.cars.get(plate);
    if (!car) return;
    car.chargeScheduled = false;
    if (car.status !== "at_exit" || car.charge_parking !== null) return;
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (!lane || lane.passageOwner !== plate || lane.passageState !== "waiting_payment") return;
    car.charge_attempts++;
    const gameS = this.parkedGameSeconds(car);
    let parking: number, basis: string;
    if (car.charge_override !== null) {
      parking = car.charge_override;
      basis = "amount stated by simulator";
    } else if (car.approved_duration_minutes !== null && car.approved_duration_minutes !== undefined) {
      parking = parkingCost(car.approved_duration_minutes * 60, car.approved_duration_minutes, car.car_type, this.cfg);
      basis = car.billing_basis ?? `operator-approved duration ${car.approved_duration_minutes}m`;
    } else {
      if (gameS === null && car.planned_minutes === null) {
        const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
        if (lane) this.holdUnknownVisit(car, lane, "no measured duration or planned duration is available");
        return;
      }
      parking = parkingCost(gameS ?? 0, car.planned_minutes, car.car_type, this.cfg);
      basis = `planned ${car.planned_minutes}m, measured ${gameS !== null ? (gameS / 60).toFixed(2) : "?"} game-min`;
    }
    const electric = chargingCost(car.car_type, this.cfg);
    let invoice;
    try {
      invoice = this.store.createInvoice({ visitId: car.visit_id ?? this.store.getOrCreateVisitId(null, plate, car.arrived_at),
        plate, parking, electricity: electric, billingBasis: basis });
    } catch (ex) {
      this.note("error", `${plate}: invoice was not sent because it could not be persisted (${(ex as Error).message})`);
      return;
    }
    this.applyInvoice(car, invoice);
    car.invoice_status = "pending";
    car.status = "invoiced";
    const sent = await this.cmd("charge", () => this.sim.carCharge(plate, parking, electric), [plate, parking, electric]);
    if (sent) {
      car.invoice_status = "issued";
      this.store.updateInvoiceStatus(invoice.id, "issued");
      this.note("info", `${plate} invoiced ${(parking + electric).toFixed(2)} (${basis})`);
    } else {
      car.invoice_status = "outcome_unknown";
      this.store.updateInvoiceStatus(invoice.id, "outcome_unknown");
      this.store.createOrUpdateIncident({ type: "invoice_outcome_unknown", correlationKey: invoice.id, severity: "high",
        summary: `Invoice result is unknown for ${plate}; do not send another charge`, plate, lane: car.exit_lane,
        details: { invoice_id: invoice.id, visit_id: car.visit_id, total_minor: invoice.total_minor } });
    }
    // On an HTTP failure we do NOT retry: the charge may have registered, and a second
    // one is a penalty. A rejection arrives as a penalty event instead (onPenalty).
  }

  /** How long the car was parked, in game time. */
  private parkedGameSeconds(car: Car): number | null {
    if (car.parkedG !== null && car.leftSpotG !== null) return car.leftSpotG - car.parkedG;
    const realS = simSecondsBetween(car.parked_at, car.left_spot_at); // wall-clock stamps
    return realS === null ? null : realS * this.timeScale;
  }

  private async onPayment(e: EventRecord) {
    const plate = str(e, "CarPlateNumber")!;
    const amount = Number(e.Amount) || 0;
    this.store.confirmCommandIntent("charge", [plate]);
    const car = this.cars.get(plate);
    if (car && car.charge_parking === null && car.visit_id) {
      const saved = this.store.activeInvoice(car.visit_id) ?? this.store.activeInvoiceForPlate(plate);
      if (saved) this.applyInvoice(car, saved);
    }
    if (!car || car.charge_parking === null) {
      this.note("warn", `payment ${amount.toFixed(2)} from ${plate} with no invoice - ignored`);
      this.store.createOrUpdateIncident({ type: "unallocated_payment", correlationKey: String(e.EventId ?? `${plate}:${amount}`),
        severity: "high", summary: `Payment from ${plate} has no matching invoice`, plate,
        details: { event_id: e.EventId ?? null, amount } });
      return;
    }
    if (car.payment_ok) {
      this.note("warn", `repeated payment evidence for already settled visit ${plate} ignored`);
      return;
    }
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (!lane || lane.passageOwner !== plate) {
      this.note("warn", `payment from ${plate} is not for the active passage owner - not releasing`);
      return;
    }
    const expected = car.charge_parking + (car.charge_electric ?? 0);
    car.paid = amount;
    if (Math.abs(amount - expected) <= this.cfg.paymentTolerance) {
      if (car.invoice_id && !this.store.settleInvoice(car.invoice_id, amount, str(e, "EventId") ?? null)) {
        this.note("warn", `duplicate settlement for invoice ${car.invoice_id} ignored`);
        return;
      }
      car.payment_ok = true;
      car.invoice_status = "settled";
      this.counters.revenue += amount;
      await this.release(car);
    } else {
      car.payment_ok = false;
      car.status = "payment_mismatch";
      this.counters.payment_mismatches++;
      this.note("error", `${plate} paid ${amount.toFixed(2)}, invoice ${expected.toFixed(2)} - NOT releasing`);
    }
  }

  async release(car: Car): Promise<void> {
    if (this.replaying) return; // whether it was released is in the recorded commands
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (lane) {
      if (lane.passageOwner !== car.plate) {
        if (!lane.queue.includes(car.plate)) lane.queue.push(car.plate);
        await this.advanceExitLane(lane);
        if (lane.passageOwner !== car.plate) return;
      }
      if (lane.passageState === "uncertain" || lane.passageState === "closing" || lane.passageState === "clearing") return;
    }
    const gate = lane?.gate ? this.gates.get(lane.gate) : undefined;
    if (lane?.gate && (!gate || !gate.operable)) {
      lane.passageState = "waiting_gate";
      this.note("warn", `exit gate ${lane.gate} not operable - ${car.plate} waits`);
      return;
    }
    if (lane) {
      lane.passageState = gate && gate.state !== GateState.Open ? "opening" : "released";
      lane.releasing.add(car.plate);
    }
    const leave = async () => {
      if (lane && lane.passageOwner !== car.plate) return;
      if (car.status !== "released") {
        car.status = "released";
        car.releasedG = this.clock.now();
        car.gotoResends = 0;
      }
      if (lane) lane.passageState = "released";
      await this.leavePark(car);
    };
    if (gate) await this.whenGateOpen(gate, leave);
    else await leave();
  }

  private async onExitOut(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    this.store.confirmCommandIntent("goto", [plate, Destination.LeavePark]);
    if (this.drivingIn(plate)) return; // passing over the exit sensor on the way to its spot
    const exitSensor = this.spots.get(lane.spot);
    if (exitSensor) exitSensor.detected = Math.max(0, exitSensor.detected - 1);
    const car = this.cars.get(plate) ?? this.adopt(e);
    const ownsPassage = lane.passageOwner === plate;
    const authorized = ownsPassage && car.status === "released" && lane.passageState === "released";
    if (!authorized) {
      this.counters.escaped++;
      this.note("error", `${plate} left without being released (status ${car.status})`);
      this.store.createOrUpdateIncident({ type: "unverified_exit", correlationKey: plate, severity: "critical",
        summary: `${plate} crossed an exit sensor without a confirmed paid passage`, plate, lane: lane.spot,
        details: { visit_id: car.visit_id ?? null, status: car.status, event_id: e.EventId ?? null } });
      if (lane.passageOwner !== null && lane.passageOwner !== plate) {
        // A second car crossed while another visit owned the lane. It may have
        // tailgated through the same opening; do not treat that opening as safe.
        lane.passageState = "uncertain";
        this.store.createOrUpdateIncident({ type: "possible_tailgate", correlationKey: lane.spot, severity: "critical",
          summary: `${plate} crossed during ${lane.passageOwner}'s exit passage`, plate, lane: lane.spot,
          details: { owner: lane.passageOwner, suspected_follower: plate, event_id: e.EventId ?? null } });
        this.note("error", `possible tailgate at ${lane.spot}: ${plate} exited during ${lane.passageOwner}'s passage; hold for review`);
      }
    }
    lane.queue = lane.queue.filter((p) => p !== plate);
    if (ownsPassage) lane.passageState = authorized ? "clearing" : "uncertain";
    this.counters.exited++;
    this.finish(car, e);
    if (authorized && car.payment_ok) this.store.resolveIncidentByCorrelation("unknown_visit", plate, "system", "operator-reviewed visit completed with valid payment");
    if (ownsPassage && authorized) this.scheduleExitPassageClose(lane, plate);
  }

  private scheduleExitPassageClose(lane: ExitLane, owner: string): void {
    if (this.replaying || lane.clearanceCloseScheduled) return;
    lane.clearanceCloseScheduled = true;
    this.later(this.cfg.gateCloseDelayGameS, `close ${lane.gate}`, async () => {
      lane.clearanceCloseScheduled = false;
      if (lane.passageOwner !== owner || lane.passageState !== "clearing") return;
      const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
      if (!gate) return this.completeExitPassage(lane);
      if (!gate.operable) {
        lane.passageState = "uncertain";
        this.note("error", `${lane.spot}: gate unavailable during exit clearance; passage requires review`);
        return;
      }
      lane.passageState = "closing";
      lane.closeRetries = 0;
      if (gate.state === GateState.Closed) await this.completeExitPassage(lane);
      else await this.closeGateIfIdle(gate.name);
    });
  }

  private async completeExitPassage(lane: ExitLane): Promise<void> {
    const owner = lane.passageOwner;
    if (owner === null) return;
    this.store.resolveIncidentByCorrelation("possible_tailgate", lane.spot, "system", "lane close confirmed after physical clearance");
    this.store.resolveIncidentByCorrelation("uncertain_exit_passage", lane.spot, "system", "lane close confirmed after physical clearance");
    lane.releasing.delete(owner);
    lane.queue = lane.queue.filter((p) => p !== owner);
    lane.passageOwner = null;
    lane.passageState = "idle";
    lane.closeRetries = 0;
    lane.clearanceCloseScheduled = false;
    await this.advanceExitLane(lane);
    const next = lane.passageOwner ? this.cars.get(lane.passageOwner) : undefined;
    if (next?.payment_ok) await this.release(next);
  }

  // ---------------------------------------------------------------------------
  // penalties, gates & components
  // ---------------------------------------------------------------------------
  private async onPenalty(e: EventRecord) {
    this.counters.penalties++;
    this.counters.fines += Number(e.FineAmount) || 0;
    const reason = str(e, "Reason") ?? "";
    this.note("error", `PENALTY ${e.FineAmount}: ${reason} (${e.ComponentName})`);

    const car = this.carByComponent(str(e, "ComponentName"));
    const lowered = reason.toLowerCase();
    if (lowered.includes(PenaltyReason.OccupiedSpot)) return this.onOccupiedSpotPenalty(reason, car);
    if (car && lowered.includes(PenaltyReason.AlreadyPaid) && ["at_exit", "invoiced", "payment_mismatch"].includes(car.status)) {
      // Our record missed its payment (e.g. across a restart); the simulator knows it paid.
      this.note("warn", `${car.plate} has already paid according to the simulator - releasing`);
      car.payment_ok = true;
      return this.release(car);
    }
    if (!car || car.status !== "invoiced") return;
    if (lowered.includes(PenaltyReason.ChargeNotAtExit)) {
      // Rejected for timing: the car is still at the exit without an invoice.
      this.rebill(car, null);
    } else if (lowered.includes(PenaltyReason.ChargedWrongly) && this.cfg.rechargeOnWrongAmount) {
      // Rejected for amount, and the simulator says what it should be. Left alone the car
      // never pays, sits on the exit sensor and blocks every car behind it.
      const m = CORRECT_AMOUNT_PATTERN.exec(reason);
      if (m) this.rebill(car, Number(m[1]));
    }
  }

  /**
   * "Car:(ARA 545) attempted to park in an occupied spot:(S12)." - the simulator is telling
   * us S12 holds a car we lost track of. Record that, and send the car somewhere free
   * straight away: re-sending it (dispatch retry) and then sending the next car there is
   * how one wrong spot became 83 penalties.
   */
  private async onOccupiedSpotPenalty(reason: string, car: Car | undefined) {
    const spotName = OCCUPIED_SPOT_PATTERN.exec(reason)?.[1]?.trim();
    const spot = spotName ? this.spots.get(spotName) : undefined;
    if (!spot) return;
    if (!spot.occupants.size) spot.occupants.add("?"); // cleared by that spot's next CarOut
    if (spot.reserved_for === car?.plate) spot.reserved_for = null;
    if (this.replaying || !car || car.spot !== spot.name || !(MID_ENTRY.includes(car.status) || car.status === "entering")) return;
    const lane = car.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
    const alt = this.allocator.choose(car.car_type, lane?.zone ?? "", this.spots.values());
    if (!alt) {
      this.note("error", `${car.plate}: ${spot.name} is taken and no other spot is free`);
      return;
    }
    alt.reserved_for = car.plate;
    car.spot = alt.name;
    car.gotoResends = 0;
    car.dispatchedG = this.clock.now();
    this.note("warn", `${spot.name} is occupied - redirecting ${car.plate} to ${alt.name}`);
    if (await this.cmd("goto", () => this.sim.carGoto(car.plate, alt.name), [car.plate, alt.name])) car.gotoG = this.clock.now();
  }

  private rebill(car: Car, override: number | null) {
    if (car.invoice_id) this.store.updateInvoiceStatus(car.invoice_id, "rejected");
    car.invoice_status = "rejected";
    car.invoice_id = null;
    car.charge_parking = car.charge_electric = null;
    car.charge_override = override;
    car.status = "at_exit";
    if (car.charge_attempts < this.cfg.maxChargeAttempts) this.scheduleCharge(car.plate, this.cfg.exitChargeRetryGameS);
    else this.note("error", `${car.plate}: invoice rejected ${car.charge_attempts}x, giving up`);
  }

  /** Penalties name cars without the space ("QNL430" for "QNL 430"). */
  private carByComponent(name?: string): Car | undefined {
    if (!name) return undefined;
    const key = name.replace(/ /g, "");
    return [...this.cars.values()].find((c) => c.plate.replace(/ /g, "") === key);
  }

  private async onGate(e: EventRecord) {
    const name = str(e, "Name")!;
    let gate = this.gates.get(name);
    if (!gate) this.gates.set(name, (gate = new Gate(name, "")));
    const was = gate.state;
    gate.state = str(e, "Action")!;
    if (gate.state === GateState.Open) this.store.confirmCommandIntent("open", [name]);
    else if (gate.state === GateState.Closed) this.store.confirmCommandIntent("close", [name]);
    if (gate.state === GateState.Closed) gate.closeRequestedAt = null;
    if (gate.moveSentReal !== null && !this.replaying) {
      // A gate move takes fixed game time: its real duration tracks the game speed.
      const expected = was === GateState.Opening ? GateState.Open : was === GateState.Closing ? GateState.Closed : null;
      if (gate.state === expected) this.learnFromGate((tsOf(e._received_at) ?? this.clock.real()) - gate.moveSentReal);
      gate.moveSentReal = null;
    }
    if (gate.state === GateState.Open) {
      await this.gateOpened(gate);
    } else if (gate.state === GateState.Closed && gate.onOpen.length && gate.hold !== "closed") {
      // An "open" sent while the gate was still closing is silently dropped by the
      // simulator: ask again now that it has finished closing.
      await this.requestOpen(gate);
    }
    if (gate.state === GateState.Closed) {
      for (const lane of this.exitLanes.values()) {
        if (lane.gate === gate.name && lane.passageState === "closing") {
          await this.completeExitPassage(lane);
        }
      }
    }
  }

  private async gateOpened(gate: Gate) {
    gate.openRequestedAt = null;
    gate.openRetries = 0;
    const callbacks = gate.onOpen;
    gate.onOpen = [];
    for (const fn of callbacks) await fn();
  }

  async whenGateOpen(gate: Gate, fn: Callback): Promise<void> {
    if (gate.state === GateState.Open) {
      await fn();
      return;
    }
    gate.onOpen.push(fn);
    if (gate.hold === "closed") return; // an operator holds it shut: the car waits until it is released
    if (gate.state !== GateState.Opening) await this.requestOpen(gate);
    else if (gate.openRequestedAt === null) gate.openRequestedAt = this.clock.now(); // opening per sync: still arm the timeout
  }

  private async requestOpen(gate: Gate) {
    const clean = gate.state === GateState.Closed, sent = this.clock.real();
    if (await this.cmd("open", () => this.sim.openGate(gate.name), [gate.name])) {
      gate.state = GateState.Opening;
      gate.openRequestedAt = this.clock.now();
      gate.closeRequestedAt = null;
      gate.moveSentReal = clean ? sent : null;
    }
  }

  private async requestClose(gate: Gate): Promise<boolean> {
    const clean = gate.state === GateState.Open, sent = this.clock.real();
    const ok = await this.cmd("close", () => this.sim.closeGate(gate.name), [gate.name]);
    if (ok) {
      gate.state = GateState.Closing;
      gate.closeRequestedAt = this.clock.now();
      gate.moveSentReal = clean ? sent : null;
    }
    return ok;
  }

  private learnFromGate(realS: number) {
    const change = this.clock.addGateMove(realS);
    if (change) this.note("warn", `game speed changed: x${change.from.toFixed(2)} -> x${change.to.toFixed(2)} (from gate timing)`);
  }

  /**
   * The simulator does not always act on a gate command. An open not confirmed in time is
   * re-sent once, then assumed; a close is re-sent once (a gate left open lets cars through).
   */
  private async checkGateTimeouts(now: number) {
    for (const gate of this.gates.values()) {
      if (gate.onOpen.length && gate.openRequestedAt !== null && now - gate.openRequestedAt >= this.cfg.gateConfirmGameS) {
        if (gate.openRetries === 0) {
          gate.openRetries = 1;
          this.note("warn", `${gate.name} did not confirm opening, re-sending open`);
          await this.requestOpen(gate);
        } else {
          if (this.cfg.webhookProfile === "level2") {
            gate.openRequestedAt = null;
            for (const lane of this.entryLanes.values()) if (lane.gate === gate.name) {
              this.store.createOrUpdateIncident({ type: "uncertain_gate_open", correlationKey: gate.name,
                severity: "high", summary: `${gate.name} did not confirm open; entry lane remains stopped`,
                component: gate.name, componentType: "gate", zone: lane.zone, lane: lane.spot,
                details: { desired_state: "Open", current_state: gate.state, retries: gate.openRetries } });
            }
            for (const lane of this.exitLanes.values()) if (lane.gate === gate.name && lane.passageOwner) {
              lane.passageState = "uncertain";
              this.store.createOrUpdateIncident({ type: "uncertain_gate_open", correlationKey: gate.name,
                severity: "critical", summary: `${gate.name} did not confirm open; exit passage held`,
                component: gate.name, componentType: "gate", zone: lane.zone, lane: lane.spot,
                details: { owner: lane.passageOwner, desired_state: "Open", current_state: gate.state, retries: gate.openRetries } });
            }
            this.note("error", `${gate.name} still unconfirmed; no vehicle command will be issued until a gate event or audited recovery`);
            continue;
          }
          this.note("warn", `${gate.name} still unconfirmed, assuming it is open`);
          gate.state = GateState.Open;
          await this.gateOpened(gate);
        }
      } else if (gate.state === GateState.Closing && gate.closeRequestedAt !== null &&
          now - gate.closeRequestedAt >= this.cfg.gateConfirmGameS) {
        gate.closeRequestedAt = null; // one re-send only
        const closingPassages = [...this.exitLanes.values()].filter((lane) => lane.gate === gate.name &&
          lane.passageOwner !== null && lane.passageState === "closing");
        if (closingPassages.length) {
          for (const lane of closingPassages) {
            if (lane.closeRetries < 1 && gate.operable) {
              lane.closeRetries++;
              this.note("warn", `${gate.name} did not confirm exit close; retrying once for ${lane.spot}`);
              await this.requestClose(gate);
            } else {
              lane.passageState = "uncertain";
              this.note("error", `${gate.name} close remains unconfirmed after retry; ${lane.spot} passage held for operator review`);
            }
          }
          continue;
        }
        if (gate.draining && !this.gateHasActiveCrossing(gate.name)) {
          const job = this.store.activeMaintenanceJob("gate", gate.name);
          if (job && gate.drainCloseRetries < 2 && gate.operable) {
            gate.drainCloseRetries++;
            this.note("warn", `${gate.name} did not confirm close during maintenance drain; retrying once`);
            await this.requestClose(gate);
          } else if (job) {
            this.store.createOrUpdateIncident({ type: "maintenance_gate_clearance", correlationKey: job.id, severity: "high",
              summary: `${gate.name} did not confirm closed after maintenance-drain retry`, component: gate.name,
              componentType: "gate", zone: gate.zone, details: { job_id: job.id, retries: gate.drainCloseRetries } });
          }
          continue;
        }
        if (gate.hold === "open" || gate.onOpen.length || this.gateBusy(gate.name) || !gate.operable) continue;
        this.note("warn", `${gate.name} did not confirm closing, re-sending close`);
        if (await this.cmd("close", () => this.sim.closeGate(gate.name), [gate.name])) gate.moveSentReal = null;
      }
    }
  }

  gateBusy(name: string): boolean {
    return [...this.entryLanes.values()].some((l) => l.gate === name && (l.current || l.queue.length)) ||
      [...this.exitLanes.values()].some((l) => l.gate === name &&
        (l.passageOwner !== null || l.queue.length > 0 || l.releasing.size > 0));
  }

  private gateHasActiveCrossing(name: string): boolean {
    const gate = this.gates.get(name);
    return !!gate?.onOpen.length ||
      [...this.entryLanes.values()].some((lane) => lane.gate === name && lane.current !== null) ||
      [...this.exitLanes.values()].some((lane) => lane.gate === name &&
        (lane.passageOwner !== null || lane.releasing.size > 0));
  }

  private async sendGateRepair(gate: Gate, job: MaintenanceJobView, actor: string): Promise<ControlResult> {
    this.store.updateMaintenanceJob(job.id, "in_progress");
    if (!await this.cmd("repair", () => this.sim.repairGate(gate.name), [gate.name], actor)) {
      const attempt = this.store.repairCommandSince(gate.name, job.requested_at);
      if (attempt?.status === "outcome_unknown") {
        this.store.updateMaintenanceJob(job.id, "in_progress", "repair request outcome unknown; duplicate submission suppressed");
        gate.maintenance = true;
        this.store.createOrUpdateIncident({ type: "repair_outcome_unknown", correlationKey: job.id, severity: "high",
          summary: `Repair result for ${gate.name} is unknown; do not submit another repair`, component: gate.name,
          componentType: "gate", zone: gate.zone, details: { job_id: job.id, command_id: attempt.id } });
        return fail(`repair ${gate.name} outcome is unknown; it is quarantined pending reconciliation`);
      }
      gate.draining = false;
      this.store.updateMaintenanceJob(job.id, "failed", "simulator rejected repair command");
      return fail(`the simulator rejected repair ${gate.name}`);
    }
    this.store.updateMaintenanceJob(job.id, "in_progress");
    gate.maintenance = true;
    gate.draining = true;
    this.note("warn", `${actor} started maintenance on ${gate.name}`);
    return ok(`maintenance started on ${gate.name}`);
  }

  private async advanceGateMaintenance(): Promise<void> {
    for (const gate of this.gates.values()) {
      if (!gate.draining || gate.maintenance) continue;
      const job = this.store.activeMaintenanceJob("gate", gate.name);
      if (!job || job.status !== "in_progress" || !job.resolution?.startsWith("waiting for lane clearance")) continue;
      if (this.gateHasActiveCrossing(gate.name)) continue;
      if (gate.state === GateState.Closed) {
        await this.sendGateRepair(gate, job, job.requested_by);
      } else if (gate.state === GateState.Open && !gate.broken && gate.operable) {
        if (gate.drainCloseRetries >= 2) {
          this.store.createOrUpdateIncident({ type: "maintenance_gate_clearance", correlationKey: job.id, severity: "high",
            summary: `${gate.name} could not confirm a safe close before maintenance`, component: gate.name,
            componentType: "gate", zone: gate.zone, details: { job_id: job.id, gate_state: gate.state, retries: gate.drainCloseRetries } });
          continue;
        }
        gate.drainCloseRetries++;
        const sent = await this.requestClose(gate);
        if (!sent) this.store.createOrUpdateIncident({ type: "maintenance_gate_clearance", correlationKey: job.id, severity: "high",
          summary: `${gate.name} close request failed; maintenance remains waiting for clearance`, component: gate.name,
          componentType: "gate", zone: gate.zone, details: { job_id: job.id, retries: gate.drainCloseRetries } });
      } else if (gate.broken && gate.state !== GateState.Closed) {
        this.store.createOrUpdateIncident({ type: "maintenance_gate_clearance", correlationKey: job.id, severity: "critical",
          summary: `${gate.name} is broken and not confirmed closed; maintenance is held until physical clearance`,
          component: gate.name, componentType: "gate", zone: gate.zone,
          details: { job_id: job.id, gate_state: gate.state, requires_operator_clearance: true } });
      }
    }
  }

  async closeGateIfIdle(name: string | null): Promise<void> {
    const gate = name ? this.gates.get(name) : undefined;
    const entryBusy = !!gate && [...this.entryLanes.values()].some((l) => l.gate === gate.name && (l.current || l.queue.length));
    const exitBusy = !!gate && [...this.exitLanes.values()].some((l) => l.gate === gate.name &&
      (l.passageOwner !== null ? l.passageState !== "closing" : l.queue.length > 0 || l.releasing.size > 0));
    if (gate && gate.operable && gate.hold !== "open" && !entryBusy && !exitBusy && !gate.onOpen.length &&
        (gate.state === GateState.Open || gate.state === GateState.Opening)) {
      await this.requestClose(gate);
    }
  }

  private async onComponent(e: EventRecord, broken: boolean) {
    if (e._accepted === false) return;
    const name = str(e, "Name") ?? "", kind = str(e, "Type") ?? "";
    const seqText = String(e.SequenceId ?? "");
    const sequence = /^\d+$/.test(seqText) ? Number(seqText) : null;
    const type = kind === ComponentType.BarrierGate ? "gate" : kind === ComponentType.ParkingSpot ? "spot"
      : kind === ComponentType.ExhaustFan ? "fan" : kind === ComponentType.Light ? "light" : null;
    const key = `${kind}:${name}`;
    const previous = this.componentSequences.get(key);
    const persistedSequence = name ? this.store.latestComponentSequence(kind, name) : null;
    const newestSequence = Math.max(previous?.sequence ?? -1, persistedSequence ?? -1);
    if (sequence !== null && sequence < newestSequence) {
      this.store.createOrUpdateIncident({ type: "stale_component_event", correlationKey: `${key}:${sequence}`,
        severity: "warning", summary: `Ignored delayed ${broken ? "failure" : "recovery"} event for ${kind} ${name}`,
        component: name || null, componentType: type, details: { received_sequence: sequence, newest_sequence: newestSequence,
          event_id: e.EventId ?? null } });
      this.note("warn", `ignored stale ${kind} component event ${e.EventId ?? sequence} for ${name}`);
      return;
    }
    if (sequence === null && this.cfg.webhookProfile === "level2" && !broken) {
      const fan = kind === ComponentType.ExhaustFan ? this.exhaustFans.get(name) : undefined;
      const currentlyBroken = kind === ComponentType.BarrierGate ? this.gates.get(name)?.broken
        : kind === ComponentType.ParkingSpot ? this.spots.get(name)?.broken
          : fan ? !this.fanHealthy(fan) : false;
      if (currentlyBroken) {
        this.store.createOrUpdateIncident({ type: "component_order_unknown", correlationKey: key, severity: "high",
          summary: `Cannot apply unsequenced recovery event for broken ${kind} ${name}`,
          component: name, componentType: type, details: { event_id: e.EventId ?? null, action: "fixed" } });
        return;
      }
    }
    if (sequence !== null && previous?.sequence === sequence && previous.broken !== broken) {
      this.store.createOrUpdateIncident({ type: "component_sequence_conflict", correlationKey: key, severity: "critical",
        summary: `Conflicting component state events share sequence ${sequence} for ${kind} ${name}`,
        component: name, componentType: type, details: { sequence, prior_state: previous.broken ? "broken" : "fixed",
          received_state: broken ? "broken" : "fixed", event_id: e.EventId ?? null } });
      if (kind === ComponentType.BarrierGate) { const gate = this.gates.get(name); if (gate) gate.broken = true; }
      if (kind === ComponentType.ParkingSpot) { const spot = this.spots.get(name); if (spot) spot.broken = true; }
      if (kind === ComponentType.ExhaustFan) this.fanBrokenOverrides.set(name, true);
      return;
    }
    if (sequence !== null) this.componentSequences.set(key, { sequence, broken });

    if (kind === ComponentType.ExhaustFan) return this.onExhaustFanComponent(name, broken);
    if (kind === ComponentType.Light) {
      if (broken) {
        const light = this.lights.get(name);
        this.store.createOrUpdateIncident({ type: "component_unavailable", correlationKey: key, severity: "warning",
          summary: `Light ${name} is reported broken; automatic repair is unsupported by the simulator API`,
          component: name, componentType: "light", zone: light?.zoneParent.available ? light.zoneParent.value : null,
          details: { repair_supported: false, simulator_type: kind } });
      } else this.store.resolveIncidentByCorrelation("component_unavailable", key, "system", "simulator reported the light fixed");
      this.note(broken ? "error" : "info", `Light ${name} ${broken ? "BROKEN" : "fixed"}; monitoring only`);
      return;
    }
    if (kind !== ComponentType.BarrierGate && kind !== ComponentType.ParkingSpot) {
      this.store.createOrUpdateIncident({ type: "unknown_component_event", correlationKey: key || "unknown", severity: "high",
        summary: `Simulator reported an unsupported component type '${kind || "missing"}'`, component: name || null,
        details: { simulator_type: kind || null, broken, event_id: e.EventId ?? null } });
      this.note("error", `ignored component event with unsupported type '${kind || "missing"}' for ${name || "unnamed component"}`);
      return;
    }
    const target = kind === ComponentType.BarrierGate ? this.gates.get(name) : this.spots.get(name);
    if (!target) {
      this.store.createOrUpdateIncident({ type: "unknown_component_event", correlationKey: key, severity: "high",
        summary: `Simulator reported ${kind} ${name}, but it is absent from the loaded equipment inventory`,
        component: name, componentType: type, details: { simulator_type: kind, broken, event_id: e.EventId ?? null } });
      return;
    }
    target.broken = broken;
    if (!broken) {
      target.maintenance = false;
      if (kind === ComponentType.BarrierGate) {
        (target as Gate).draining = false;
        (target as Gate).drainCloseRetries = 0;
      }
      this.store.confirmCommandIntent("repair", [name]);
      this.store.finishMaintenanceJob(kind === ComponentType.BarrierGate ? "gate" : "spot", name,
        "simulator reported component fixed");
      this.store.resolveIncidentByCorrelation("component_unavailable", key, "system", "simulator reported the component fixed");
    } else {
      this.store.createOrUpdateIncident({ type: "component_unavailable", correlationKey: key, severity: "high",
        summary: `${kind} ${name} is broken`, component: name, componentType: type,
        zone: kind === ComponentType.BarrierGate ? (target as Gate).zone : (target as Spot).zone,
        details: { simulator_type: kind } });
    }
    this.note(broken ? "error" : "info", `${kind} ${name} ${broken ? "BROKEN" : "fixed"}`);
    if (!broken) {
      for (const lane of this.entryLanes.values()) await this.pumpEntry(lane);
      for (const lane of this.exitLanes.values()) {
        if (lane.gate !== name || lane.passageOwner === null) continue;
        const car = this.cars.get(lane.passageOwner);
        if (car?.payment_ok) await this.release(car);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // housekeeping
  // ---------------------------------------------------------------------------
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const t of this.timers.filter((t) => t.due <= now)) await this.runTimer(t);
    await this.checkGateTimeouts(now);
    await this.advanceGateMaintenance();
    await this.checkStuckGotos(now);
    await this.sweepGhosts(now);
    this.sample(nowS());
    const horizon = now - this.cfg.repeatExitWindowGameS;
    for (const [plate, t] of this.recentPaid) if (t < horizon) this.recentPaid.delete(plate);
  }

  /**
   * The simulator acknowledges every goto but silently drops some - mostly ones that land
   * while another car's event fires. The car then just sits on its sensor: at an entry it
   * holds the lane (every car behind it waits, then all go at once), at an exit it holds
   * the open gate. A car that has not driven off gotoConfirmGameS after its goto gets it
   * again; a car told to go to the same place twice simply keeps going.
   */
  private async checkStuckGotos(now: number) {
    for (const car of [...this.cars.values()]) {
      if (car.gotoG === null || now - car.gotoG < this.cfg.gotoConfirmGameS) continue;
      const entry = car.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
      const onEntry = car.status === "dispatched" && entry?.current === car.plate;
      if (!onEntry && car.status !== "released" && car.status !== "turned_away") continue;
      const where = car.status === "released" ? car.exit_lane : car.entry_lane;
      const dest = onEntry ? car.spot : Destination.LeavePark;
      if (car.gotoResends >= this.cfg.maxGotoResends) {
        car.gotoG = null; // stop re-sending
        if (onEntry) await this.giveUpOnEntry(car, entry!);
        else this.note("error", `${car.plate} still has not left ${where} after ${car.gotoResends} re-sent gotos`);
        continue;
      }
      car.gotoResends++;
      this.note("warn", `${car.plate} has not moved off ${where} ${(now - car.gotoG).toFixed(1)} game-s after goto ${dest} - ` +
        `re-sending (${car.gotoResends}/${this.cfg.maxGotoResends})`);
      car.gotoG = now; // not re-checked until the next confirm window, even if the re-send fails
      if (onEntry) await this.sendToSpot(car.plate, entry!);
      else if (car.status === "turned_away") await this.leavePark(car);
      else await this.release(car);
    }
  }

  private async giveUpOnEntry(car: Car, lane: EntryLane) {
    this.note("error", `${car.plate} stuck at ${lane.spot}, releasing the lane`);
    const spot = car.spot ? this.spots.get(car.spot) : undefined;
    if (this.cfg.webhookProfile === "level2" && spot) {
      // A failed goto acknowledgement does not prove the car failed to move. Keep the
      // destination reserved until a fresh simulator observation or audited physical
      // reconciliation establishes that the spot is empty.
      car.status = "unknown";
      car.state_version = (car.state_version ?? 0) + 1;
      lane.current = null;
      this.store.saveVisitState(publicCar(car));
      this.store.createOrUpdateIncident({ type: "uncertain_reservation", correlationKey: car.visit_id!, severity: "high",
        summary: `${car.plate}'s assigned destination ${spot.name} is uncertain after the entry command stopped responding` ,
        plate: car.plate, component: spot.name, componentType: "spot", zone: spot.zone, lane: lane.spot,
        details: { visit_id: car.visit_id, spot: spot.name, detected: spot.detected, command: "goto", reservation_retained: true } });
      await this.pumpEntry(lane);
      return;
    }
    if (spot?.reserved_for === car.plate) spot.reserved_for = null;
    car.status = "lost";
    car.spot = null;
    lane.current = null;
    await this.pumpEntry(lane);
  }

  /**
   * Run fn after delayGameS game seconds. While running, each timer fires on its own
   * setTimeout (through the serial queue) so gate closes are on time rather than rounded
   * up to the next tick; if the game speed dropped meanwhile it is re-armed for the rest.
   * tick() still sweeps anything due, which is also how tests advance time.
   */
  later(delayGameS: number, label: string, fn: Callback): void {
    if (this.replaying) return; // reconcile() re-arms whatever is still relevant after a replay
    const timer: Timer = { due: this.clock.now() + delayGameS, label, fn, done: false };
    this.timers.push(timer);
    this.arm(timer);
  }

  private arm(timer: Timer) {
    if (!this.started || timer.done) return;
    setTimeout(() => this.queue.push(async () => {
      if (timer.done) return;
      if (this.clock.now() < timer.due - 1e-3) this.arm(timer); // game time ran slower than planned
      else await this.runTimer(timer);
    }), this.clock.realUntil(timer.due) * 1000);
  }

  private async runTimer(t: Timer) {
    if (t.done) return;
    t.done = true;
    this.timers = this.timers.filter((x) => x !== t);
    await t.fn();
  }

  /** A car we have no record of (e.g. it arrived before we started). */
  private adopt(e: EventRecord): Car {
    const plate = str(e, "CarPlateNumber")!;
    const car = newCar(plate, str(e, "CarType") || CarType.Normal, toInt(e.PlannedParkingDurationInMinutes), "unknown", {
      visit_id: this.store.getOrCreateVisitId(str(e, "EventId") ?? null, plate, e.ServerDateTime),
    });
    this.cars.set(plate, car);
    this.note("warn", `adopted unknown car ${plate} at ${e.SpotName}`);
    return car;
  }

  /** Let go of everything a car record holds: spot, reservation, lanes. */
  private detach(car: Car) {
    for (const s of this.spots.values()) {
      s.occupants.delete(car.plate);
      if (s.reserved_for === car.plate) s.reserved_for = null;
    }
    for (const lane of this.entryLanes.values()) {
      lane.queue = lane.queue.filter((p) => p !== car.plate);
      if (lane.current === car.plate) lane.current = null;
    }
    for (const lane of this.exitLanes.values()) {
      lane.queue = lane.queue.filter((p) => p !== car.plate);
      if (lane.passageOwner !== car.plate) lane.releasing.delete(car.plate);
    }
  }

  /** Remove a stale record without keeping it (the plate is reused by a new car). */
  private forget(car: Car) {
    this.detach(car);
    this.cars.delete(car.plate);
    if (car.visit_id) this.store.closeVisit(car.visit_id, "superseded", publicCar(car));
  }

  /** Close a car record whose closing event never arrived, and store it as a session. */
  private retire(car: Car, why: string, status: CarStatus = "lost") {
    this.note("warn", `${car.plate} ${why} - closing its record (event lost or simulator restarted)`);
    this.detach(car);
    car.gotoG = null;
    car.status = status;
    this.counters.ghosts_retired++;
    this.finish(car, { EventClass: "", _received_at: new Date().toISOString() });
  }

  /**
   * Retire car records that should have ended by now. Webhooks are at-most-once and a
   * simulator restart makes cars vanish, so a record can miss its closing event; left
   * alone it would hold a lane, a spot count or - worst - keep an exit gate open.
   */
  private async sweepGhosts(now: number) {
    const gatesToClose = new Set<string>();
    const retiredBefore = this.counters.ghosts_retired;
    // All in game time: a speed change or a paused game does not age anyone early.
    for (const car of [...this.cars.values()]) {
      const quietFor = now - (car.lastSeenG ?? car.arrivedG ?? now);
      if (car.status === "released" && car.releasedG !== null && now - car.releasedG > this.cfg.releaseTimeoutGameS) {
        const gate = car.exit_lane ? this.exitLanes.get(car.exit_lane)?.gate : null;
        const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
        if (lane?.passageOwner === car.plate) {
          lane.passageState = "uncertain";
          this.store.createOrUpdateIncident({ type: "uncertain_exit_passage", correlationKey: lane.spot, severity: "critical",
            summary: `No exit-clearance event was received for ${car.plate}`, plate: car.plate, lane: lane.spot,
            details: { visit_id: car.visit_id ?? null, gate: lane.gate } });
          this.note("error", `${car.plate} has no confirmed exit clearance at ${lane.spot}; lane is held for operator review`);
          this.retire(car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
        } else {
          this.retire(car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
          if (gate) gatesToClose.add(gate);
        }
      } else if (car.status === "parked") {
        const since = car.parkedG ?? car.lastSeenG;
        const allowed = (car.planned_minutes ?? 0) * 60 + this.cfg.parkedOverstayGameS;
        if (since !== null && now - since > allowed) this.retire(car, `is still recorded in ${car.spot} well past its planned ${car.planned_minutes}m`);
      } else if (car.status === "queued") {
        if (now - (car.arrivedG ?? now) > this.cfg.entryPatienceGameS + 60) this.retire(car, `is still queued at ${car.entry_lane} past the give-up time`);
      } else if (this.cfg.webhookProfile === "level2" && car.status === "unknown" && car.spot &&
          this.spots.get(car.spot)?.reserved_for === car.plate) {
        // Do not turn silence into proof that an assigned vehicle or reservation vanished.
        // An operator can release this quarantine only after a fresh detector/physical check.
        continue;
      } else if (["to_exit", "at_exit", "invoiced", "payment_mismatch", "entering", "unknown", "turned_away"].includes(car.status)) {
        if (quietFor > this.cfg.staleCarGameS) {
          this.retire(car, `has had no events for ${Math.round(quietFor)} game-s (status ${car.status})`,
            car.status === "turned_away" ? "turned_away" : "lost");
        }
      }
    }
    for (const gate of gatesToClose) await this.closeGateIfIdle(gate);
    if (this.counters.ghosts_retired > retiredBefore) {
      for (const lane of this.entryLanes.values()) await this.pumpEntry(lane); // spots/lanes freed
    }
  }

  private finish(car: Car, e: EventRecord) {
    car.state_version = (car.state_version ?? 0) + 1;
    car.left_at = e.ServerDateTime ?? null;
    if (!["neglected", "turned_away", "lost"].includes(car.status)) car.status = "gone";
    if (car.payment_ok) this.recentPaid.set(car.plate, this.clock.now());
    const session: SessionView = { ...publicCar(car), parked_seconds: simSecondsBetween(car.parked_at, car.left_spot_at) };
    this.completed.push(session);
    if (this.completed.length > this.cfg.completedSessionsSize) this.completed.shift();
    if (!this.replaying) this.store.recordSession(session); // already stored the first time round
    this.cars.delete(car.plate);
  }

  private async cmd(what: string, fn: () => Promise<void>, args: (string | number)[], actor: string | null = null): Promise<boolean> {
    if (this.replaying) return true; // the command was sent the first time round
    let intentId: string;
    try {
      intentId = this.store.startCommandIntent(what, args, actor);
    } catch (ex) {
      this.counters.command_errors++;
      this.note("error", `command ${what} was not sent because its intent could not be persisted: ${(ex as Error).message}`);
      return false;
    }
    const t0 = performance.now();
    let ok = true, error: string | null = null;
    let outcome: "acknowledged" | "rejected" | "outcome_unknown" = "acknowledged";
    try {
      await fn();
    } catch (ex) {
      ok = false;
      error = (ex as Error).message ?? String(ex);
      outcome = /(?:->|status\s*)\s*4\d\d\b/.test(error) ? "rejected" : "outcome_unknown";
      this.counters.command_errors++;
      this.note("error", `command ${what}(${args.join(", ")}) ${outcome === "rejected" ? "rejected" : "outcome unknown"}: ${error}`);
    }
    try {
      this.store.finishCommandIntent(intentId, outcome, error);
      this.store.recordAction({
        at: new Date().toISOString(), cmd: what, args: args.map(String), ok, error,
        ms: Math.round((performance.now() - t0) * 10) / 10, actor,
      });
    } catch (ex) {
      // The pending intent is deliberately left for startup recovery. Never retry here:
      // the simulator may have acted even if persistence of the response failed.
      this.note("error", `command ${what} returned but its outcome could not be durably recorded; recovery required`);
    }
    return ok;
  }

  note(level: FeedLevel, msg: string): void {
    if (this.replaying) return;
    this.feed.push({ at: new Date().toISOString(), level, msg });
    if (this.feed.length > this.cfg.feedSize) this.feed.shift();
    this.log[level === "warn" ? "warn" : level === "error" ? "error" : "info"](msg);
  }

  // ---------------------------------------------------------------------------
  // manual control from the dashboard - always run through exclusive()
  // ---------------------------------------------------------------------------
  /** Run fn in turn with webhooks and ticks, so it never sees half-updated state. */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.queue.run(fn);
  }

  /**
   * open / close: hold the gate that way (the automation will not override it) until
   * "auto" hands it back. repair: start maintenance. Refuses anything the spec penalises:
   * operating a broken or under-maintenance gate, or working on a gate a car is using.
   */
  async manualGate(name: string, action: GateAction, actor: string, reason = `maintenance requested by ${actor}`, jobId?: string): Promise<ControlResult> {
    const gate = this.gates.get(name);
    if (!gate) return fail(`unknown gate ${name}`);
    const unusable = gate.broken ? "broken" : gate.maintenance ? "under maintenance" : null;
    const inUse = this.gateBusy(name) || gate.onOpen.length > 0;
    const exitOwned = [...this.exitLanes.values()].some((lane) => lane.gate === name &&
      (lane.passageOwner !== null || lane.queue.length > 0));
    switch (action) {
      case "open":
      case "close": {
        if (gate.draining) return fail(`${name} is draining for maintenance; new manual operation is blocked`);
        if (unusable) return fail(`${name} is ${unusable} - operating it now is a penalty`);
        if (action === "open" && exitOwned) return fail(`${name} is controlled by an exit payment/passage queue`);
        if (action === "close" && inUse) return fail(`${name} is letting a car through right now - try again in a moment`);
        gate.hold = action === "open" ? "open" : "closed";
        const sent = action === "open"
          ? await this.cmd("open", () => this.sim.openGate(name), [name], actor)
          : await this.cmd("close", () => this.sim.closeGate(name), [name], actor);
        if (!sent) { gate.hold = null; return fail(`the simulator rejected ${action} ${name}`); }
        gate.moveSentReal = gate.closeRequestedAt = null; // not an automatic move: no timing sample, no re-send
        if (action === "open" && gate.state !== GateState.Open) gate.state = GateState.Opening;
        if (action === "close") gate.state = GateState.Closing;
        this.note("warn", `${actor} holds ${name} ${gate.hold}`);
        return ok(`${name} held ${gate.hold} until returned to automatic`);
      }
      case "auto": {
        if (gate.draining) return fail(`${name} is draining for maintenance; finish or cancel that job first`);
        gate.hold = null;
        if (gate.onOpen.length && gate.operable) await this.requestOpen(gate); // cars were waiting on it
        else await this.closeGateIfIdle(name);
        this.note("info", `${actor} returned ${name} to automatic`);
        return ok(`${name} is automatic again`);
      }
      case "repair": {
        if (gate.maintenance) return fail(`${name} is already under maintenance`);
        let job = jobId ? this.store.getMaintenanceJob(jobId) : undefined;
        if (jobId && (!job || job.component_type !== "gate" || job.component !== name || job.status !== "requested")) {
          return fail("maintenance request is missing, mismatched, or no longer awaiting start");
        }
        if (!job && this.store.activeMaintenanceJob("gate", name)) return fail(`${name} already has an active maintenance job`);
        try {
          job ??= this.store.createMaintenanceJob({ componentType: "gate", component: name, zone: gate.zone,
            requestedBy: actor, assignedTo: actor, reason });
        } catch (error) {
          return fail(`could not persist maintenance job for ${name}: ${(error as Error).message}`);
        }
        gate.draining = true;
        if (this.gateHasActiveCrossing(name)) {
          this.store.updateMaintenanceJob(job.id, "in_progress", "waiting for lane clearance; active passage will finish before repair");
          return ok(`${name} is draining; the active crossing will finish before repair starts`);
        }
        if (gate.state === GateState.Open && !gate.broken && gate.operable) {
          this.store.updateMaintenanceJob(job.id, "in_progress", "waiting for lane clearance; gate must confirm closed before repair");
          return ok(`${name} is draining; waiting for the gate to confirm closed before repair`);
        }
        if (gate.state !== GateState.Closed) {
          this.store.updateMaintenanceJob(job.id, "in_progress", "waiting for lane clearance; gate state is not confirmed closed");
          this.store.createOrUpdateIncident({ type: "maintenance_gate_clearance", correlationKey: job.id, severity: "high",
            summary: `${name} is not confirmed closed; maintenance repair is held`, component: name, componentType: "gate",
            zone: gate.zone, details: { job_id: job.id, gate_state: gate.state, requires_operator_clearance: gate.broken } });
          return fail(`${name} is not confirmed closed; no repair command was sent`);
        }
        return this.sendGateRepair(gate, job, actor);
      }
    }
  }

  async manualSpotRepair(name: string, actor: string, reason = `maintenance requested by ${actor}`, jobId?: string): Promise<ControlResult> {
    const spot = this.spots.get(name);
    if (!spot || spot.purpose !== SpotPurpose.Park) return fail(`unknown parking spot ${name}`);
    if (spot.maintenance) return fail(`${name} is already under maintenance`);
    const who = spot.occupant ?? spot.reserved_for;
    if (who) return fail(`${name} is ${spot.occupant ? "occupied" : "reserved"}${who !== "?" ? ` by ${who}` : ""} - repairing it now is a penalty`);
    if (spot.detected > spot.occupants.size) return fail(`${name} has ${spot.detected} simulator-detected vehicle(s) but only ${spot.occupants.size} identified occupant(s); quarantine and resolve occupancy before repair`);
    let job = jobId ? this.store.getMaintenanceJob(jobId) : undefined;
    if (jobId && (!job || job.component_type !== "spot" || job.component !== name || job.status !== "requested")) {
      return fail("maintenance request is missing, mismatched, or no longer awaiting start");
    }
    if (!job && this.store.activeMaintenanceJob("spot", name)) return fail(`${name} already has an active maintenance job`);
    try {
      job ??= this.store.createMaintenanceJob({ componentType: "spot", component: name, zone: spot.zone,
        requestedBy: actor, assignedTo: actor, reason });
    } catch (error) {
      return fail(`could not persist maintenance job for ${name}: ${(error as Error).message}`);
    }
    if (!(await this.cmd("repair", () => this.sim.repairSpot(name), [name], actor))) {
      const attempt = this.store.repairCommandSince(name, job.requested_at);
      if (attempt?.status === "outcome_unknown") {
        this.store.updateMaintenanceJob(job.id, "in_progress", "repair request outcome unknown; duplicate submission suppressed");
        spot.maintenance = true;
        this.store.createOrUpdateIncident({ type: "repair_outcome_unknown", correlationKey: job.id, severity: "high",
          summary: `Repair result for ${name} is unknown; do not submit another repair`, component: name,
          componentType: "spot", zone: spot.zone, details: { job_id: job.id, command_id: attempt.id } });
        return fail(`repair ${name} outcome is unknown; it is quarantined pending reconciliation`);
      }
      this.store.updateMaintenanceJob(job.id, "failed", "simulator rejected repair command");
      return fail(`the simulator rejected repair ${name}`);
    }
    this.store.updateMaintenanceJob(job.id, "in_progress");
    spot.maintenance = true; // not offered to cars until the simulator reports it fixed
    this.note("warn", `${actor} started maintenance on ${name}`);
    return ok(`maintenance started on ${name}`);
  }

  async manualFanRepair(name: string, actor: string, reason = `maintenance requested by ${actor}`, jobId?: string): Promise<ControlResult> {
    const fan = this.exhaustFans.get(name);
    if (!fan || !fan.zoneParent.available) return fail(`unknown or ambiguously-zoned exhaust fan ${name}`);
    if (this.fanMaintenanceOverrides.get(name) === true ||
        (fan.isUnderMaintenance.available && fan.isUnderMaintenance.value) ||
        (fan.isRepairRequested.available && fan.isRepairRequested.value) ||
        (fan.repairProgress.available && fan.repairProgress.value > 0)) return fail(`${name} already has a repair in progress`);
    const componentBroken = this.fanBrokenOverrides.get(name) ?? this.store.latestComponentBroken(ComponentType.ExhaustFan, name);
    if (componentBroken !== true && !(fan.broken.available && fan.broken.value)) {
      return fail(`${name} has no confirmed failure; usage-based preventive fan-repair thresholds are not calibrated`);
    }
    const zone = fan.zoneParent.value;
    const safety = this.coStates.get(zone);
    if (safety?.ventilationRequired || safety?.restricted) {
      if (!this.fanInventoryComplete) return fail(`CO safety is active in ${zone}; fan inventory is incomplete, so a safe replacement cannot be confirmed`);
      this.note("info", `checking fresh exhaust-fan state once before repairing ${name} during active CO ventilation`);
      const backup = await this.hasConfirmedRunningBackupFan(zone, name);
      if (!backup) return fail(`CO safety is active in ${zone}; keep ${name} in service until another healthy, running fan is confirmed`);
    }
    let job = jobId ? this.store.getMaintenanceJob(jobId) : undefined;
    if (jobId && (!job || job.component_type !== "fan" || job.component !== name || job.status !== "requested")) {
      return fail("maintenance request is missing, mismatched, or no longer awaiting start");
    }
    if (!job && this.store.activeMaintenanceJob("fan", name)) return fail(`${name} already has an active maintenance job`);
    try {
      job ??= this.store.createMaintenanceJob({ componentType: "fan", component: name, zone,
        requestedBy: actor, assignedTo: actor, reason });
    } catch (error) {
      return fail(`could not persist maintenance job for ${name}: ${(error as Error).message}`);
    }
    if (!this.sim.repairFan) {
      this.store.updateMaintenanceJob(job.id, "failed", "simulator client does not support exhaust fan repair");
      return fail("exhaust fan repair is unsupported by the configured simulator client");
    }
    this.fanMaintenanceOverrides.set(name, true); // quarantine before command; only a fixed event releases it
    if (!await this.cmd("repair", () => this.sim.repairFan!(name), [name], actor)) {
      const attempt = this.store.repairCommandSince(name, job.requested_at);
      if (attempt?.status === "outcome_unknown") {
        this.store.updateMaintenanceJob(job.id, "in_progress", "repair request outcome unknown; duplicate submission suppressed");
        this.store.createOrUpdateIncident({ type: "repair_outcome_unknown", correlationKey: job.id, severity: "high",
          summary: `Repair result for ${name} is unknown; do not submit another repair`, component: name,
          componentType: "fan", zone, details: { job_id: job.id, command_id: attempt.id } });
        return fail(`repair ${name} outcome is unknown; the fan is quarantined pending reconciliation`);
      }
      this.fanMaintenanceOverrides.delete(name);
      this.store.updateMaintenanceJob(job.id, "failed", "simulator rejected repair command");
      return fail(`the simulator rejected repair ${name}`);
    }
    this.store.updateMaintenanceJob(job.id, "in_progress");
    this.note("warn", `${actor} started maintenance on exhaust fan ${name}`);
    return ok(`maintenance started on ${name}; it remains unavailable until a fixed event is confirmed`);
  }

  /** Operator confirms physical clearance after a missing/ambiguous exit event. */
  async confirmExitClearance(spot: string, reason: string, actor: string): Promise<ControlResult> {
    const lane = this.exitLanes.get(spot);
    if (!lane) return fail(`unknown exit lane ${spot}`);
    if (lane.passageState !== "uncertain" || lane.passageOwner === null) return fail(`${spot} has no uncertain passage to clear`);
    if (reason.trim().length < 8) return fail("clearance reason must be at least 8 characters");
    const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
    if (lane.gate && !gate) return fail(`gate state for ${lane.gate} is unknown`);
    if (gate && !gate.operable) return fail(`${gate.name} must be repaired before clearing this passage`);
    if (gate?.hold === "open") return fail(`${gate.name} is held open; return it to automatic before clearing this passage`);

    this.note("warn", `${actor} confirmed physical clearance for ${spot}/${lane.passageOwner}: ${reason.trim()}`);
    this.store.recordAudit({ actorUsername: actor, action: "exit.clearance_confirmed", target: spot, reason: reason.trim(),
      details: { owner: lane.passageOwner, gate: lane.gate } });
    lane.passageState = "closing";
    lane.closeRetries = 0;
    if (!gate || gate.state === GateState.Closed) {
      await this.completeExitPassage(lane);
      return ok(`${spot} passage cleared`);
    }
    const sent = await this.requestClose(gate);
    if (!sent) {
      lane.passageState = "uncertain";
      return fail(`could not request ${gate.name} close; passage remains uncertain`);
    }
    return ok(`clearance recorded for ${spot}; waiting for ${gate.name} to confirm closed`);
  }

  /** Close an entrance (arriving cars are turned away; queued cars are still served) or reopen it. */
  async setEntryOpen(spot: string, open: boolean, actor: string): Promise<ControlResult> {
    const lane = this.entryLanes.get(spot);
    if (!lane) return fail(`unknown entrance ${spot}`);
    lane.closed = !open;
    this.note("warn", `${actor} ${open ? "reopened" : "closed"} entrance ${spot}`);
    if (open) await this.pumpEntry(lane);
    return ok(`entrance ${spot} ${open ? "open" : "closed - arriving cars are turned away"}`);
  }

  // ---------------------------------------------------------------------------
  // occupancy time series (for the dashboard's charts)
  // ---------------------------------------------------------------------------
  timeseries: TimeseriesPoint[] = [];
  private lastSampleReal = 0;

  private sample(now: number) {
    if (!this.synced || now - this.lastSampleReal < this.cfg.statsSampleS) return;
    this.lastSampleReal = now;
    const total = { occupied: 0, reserved: 0, free: 0, out_of_service: 0, capacity: 0 };
    for (const z of Object.values(this.zoneSummaries())) {
      total.occupied += z.occupied; total.reserved += z.reserved; total.free += z.free;
      total.out_of_service += z.out_of_service; total.capacity += z.total;
    }
    const queued = [...this.entryLanes.values()].reduce((n, l) => n + l.queue.length, 0);
    this.timeseries.push({ t: new Date(now * 1000).toISOString(), ...total, queued });
    if (this.timeseries.length > this.cfg.statsSampleKeep) this.timeseries.shift();
  }

  // ---------------------------------------------------------------------------
  // read model for the web layer
  // ---------------------------------------------------------------------------
  private zoneSummaries(): Record<string, ZoneSummary> {
    const zones: Record<string, ZoneSummary> = {};
    for (const s of this.spots.values()) {
      if (s.purpose !== SpotPurpose.Park) continue;
      const z = (zones[s.zone || "-"] ??= { total: 0, occupied: 0, reserved: 0, free: 0, out_of_service: 0 });
      z.total++;
      if (s.broken || s.maintenance) z.out_of_service++;
      else if (s.occupant) z.occupied++;
      else if (s.reserved_for) z.reserved++;
      else z.free++;
    }
    return zones;
  }

  snapshot(): StateSnapshot {
    const zones = this.zoneSummaries();
    const spots = [...this.spots.values()]
      .sort((a, b) => a.purpose.localeCompare(b.purpose) || spotNumber(a.name) - spotNumber(b.name))
      .map((s) => ({
        name: s.name, zone: s.zone, purpose: s.purpose, car_type: s.car_type, broken: s.broken,
        maintenance: s.maintenance, occupant: s.occupant, occupants: [...s.occupants], reserved_for: s.reserved_for, detected: s.detected,
        available: s.available, manual_occupancy: s.manualOccupancy, manual_occupancy_version: s.manualOccupancyVersion,
      }));
    return {
      synced: this.synced,
      time_scale: Math.round(this.timeScale * 1000) / 1000,
      time_scale_source: this.timeScaleInfo.source,
      topology: this.topology ? { name: this.topology.name, source: this.topology.source ?? "" } : null,
      zones,
      spots,
      gates: [...this.gates.values()].map((g) => ({ name: g.name, zone: g.zone, state: g.state, broken: g.broken,
        maintenance: g.maintenance, draining: g.draining, hold: g.hold })),
      entry_lanes: [...this.entryLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, queue: [...l.queue], current: l.current, closed: l.closed })),
      exit_lanes: [...this.exitLanes.values()].map((l) => ({
        spot: l.spot, gate: l.gate, zone: l.zone, queue: [...l.queue], passage_owner: l.passageOwner,
        passage_state: l.passageState, releasing: [...l.releasing].sort(),
      })),
      active_cars: [...this.cars.values()].map(publicCar),
      recent_sessions: this.completed.slice(-50),
      counters: { ...this.counters },
      feed: this.feed.slice(-100),
    };
  }
}
