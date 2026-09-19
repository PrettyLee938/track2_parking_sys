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
import {
  CORRECT_AMOUNT_PATTERN, OCCUPIED_SPOT_PATTERN, CarType, ComponentType, Destination, Direction, EventClass, GateState, PenaltyReason,
  SpotPurpose,
  type CarStatus, type CarView, type ControlResult, type Counters, type FeedItem, type FeedLevel, type GateAction,
  type GateHold, type SessionView, type SimParkingSpot, type StateSnapshot, type TimeScaleSource, type TimeseriesPoint,
  type ZoneSummary,
} from "@gpa/shared";
import { randomUUID } from "node:crypto";
import { getAllocator, spotNumber, type Allocator, type AllocSpot } from "./allocation";
import { chargingCost, parkingCost } from "./billing";
import { readSimGameSpeed, type Settings } from "./config";
import { ComponentRegistry } from "./components";
import { GameClock } from "./gameClock";
import { createSubsystems, type Engine, type Subsystem } from "./subsystems";
import { SerialQueue, type TaskQueue } from "./serialQueue";
import { SimError, type SimApi } from "./simClient";
import type { ActionRecord, EventRecord, Store } from "./store";
import { matches, resolve as resolveTopology, type Topology } from "./topology";

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
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const seconds = (b - a) / 1000;
  // A simulator restart or out-of-order delivery can make wall-clock stamps move
  // backwards. That is not a short stay; keep it unknown for billing/reporting.
  return seconds >= 0 ? seconds : null;
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
const visitIdFor = (e: EventRecord): string | undefined => e.EventId ? `visit:${String(e.EventId)}` : undefined;
const entityId = (kind: string, visitId: string | null | undefined, suffix: string) =>
  visitId ? `${kind}:${visitId}:${suffix}` : randomUUID();

// =============================================================================
// state
// =============================================================================
export class Spot implements AllocSpot {
  broken = false;
  maintenance = false;
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
    return this.occupants.size ? "?" : null;
  }

  get available(): boolean {
    return this.purpose === SpotPurpose.Park && !this.broken && !this.maintenance &&
      this.occupants.size === 0 && this.reserved_for === null;
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
  releasing: Set<string>;  // paid plates sent to leavepark, not out yet
  queue: string[];         // ordered cars at the payment/exit sensor
  active: string | null;    // the only car allowed to own the current passage
  recovery: boolean;       // a missing exit event requires reconciliation
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
  paymentRecorded: boolean;
}

function newCar(plate: string, carType: string, planned: number | null, status: CarStatus, extra: Partial<Car> = {}): Car {
  return {
    plate, car_type: carType, planned_minutes: planned, status,
    entry_lane: null, exit_lane: null, arrived_at: null, spot: null, parked_at: null, left_spot_at: null,
    exit_at: null, charge_parking: null, charge_electric: null, charge_attempts: 0, charge_override: null,
    paid: null, payment_ok: null, left_at: null,
    visit_id: extra.visit_id ?? randomUUID(), run_id: extra.run_id ?? null, reservation_id: extra.reservation_id ?? null,
    passage_id: extra.passage_id ?? null, invoice_id: extra.invoice_id ?? null, unknown_reason: extra.unknown_reason ?? null,
    billing_basis: extra.billing_basis ?? null,
    arrivedG: null, dispatchedG: null, parkedG: null, leftSpotG: null, releasedG: null, lastSeenG: null,
    gotoG: null, gotoResends: 0, parkedA: null, leftSpotA: null, chargeScheduled: false,
    paymentRecorded: false,
    ...extra,
  };
}

export function publicCar(c: Car): CarView {
  const { arrivedG, dispatchedG, parkedG, leftSpotG, releasedG, lastSeenG, gotoG, gotoResends, parkedA, leftSpotA,
    chargeScheduled, paymentRecorded, ...view } = c;
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
  /** Plug-in subsystems; defaults to createSubsystems() in subsystems.ts. */
  subsystems?: (engine: Engine) => Subsystem[];
}

// =============================================================================
// controller
// =============================================================================
export class Controller implements Engine {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly store: Store;
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
  lastEventReal: number | null = null;
  private tickHandle: NodeJS.Timeout | null = null;
  private tickPending = false;
  private stopped = false;
  readonly runId = randomUUID();

  topology: Topology | null = null;
  spots = new Map<string, Spot>();
  gates = new Map<string, Gate>();
  entryLanes = new Map<string, EntryLane>();
  exitLanes = new Map<string, ExitLane>();
  cars = new Map<string, Car>();                  // active cars by plate
  recentPaid = new Map<string, number>();         // plate -> when its paid session ended (game clock)
  readonly clock: GameClock;
  timers: Timer[] = [];
  /** Core: health and usage of every part (Level 2). Sees events before the plug-ins. */
  readonly components: ComponentRegistry;
  lastCommandOutcome: "ok" | "failed" | "unknown" | null = null;
  /** components first, then the plug-ins. */
  readonly subsystems: Subsystem[];

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
    this.log = deps.log ?? console;
    this.allocator = getAllocator(this.cfg.allocationStrategy);
    this.topologyCandidates = deps.topologies;
    this.queue = deps.queue ?? new SerialQueue((err) => this.log.error(`controller task failed: ${(err as Error)?.stack ?? err}`));
    this.clock = deps.clock ?? new GameClock(this.cfg);
    this.clock.setSettingsSpeed(readSimGameSpeed(this.cfg.simSettingsFile));
    this.components = new ComponentRegistry(this);
    this.subsystems = [this.components, ...(deps.subsystems ?? createSubsystems)(this)];
  }

  /** Run one hook on every subsystem; one failing never stops the others or the engine. */
  private async each(hook: string, fn: (s: Subsystem) => Promise<void> | void) {
    for (const s of this.subsystems) {
      try {
        await fn(s);
      } catch (err) {
        this.note("error", `subsystem ${s.name} failed in ${hook}: ${(err as Error)?.stack ?? err}`);
      }
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
      this.exitLanes = new Map(this.topology.exit_lanes.map((l) => [l.spot, { ...l, releasing: new Set<string>(), queue: [], active: null, recovery: false }]));
    }

    for (const s of liveSpots) this.upsertSpot(s);
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
    await this.reconcile(freshLayout);
    this.synced = true;

    const park = [...this.spots.values()].filter((s) => s.purpose === SpotPurpose.Park);
    const speed = this.timeScaleInfo;
    this.note("info", `Synced '${this.topology!.name}': ${this.entryLanes.size} entries, ${this.exitLanes.size} exits, ` +
      `${park.length} park spots (${park.filter((s) => s.available).length} free); tracking ${this.cars.size} cars; ` +
      `game speed ${speed.value.toFixed(2)} (${speed.source})`);
    await this.each("onSync", (s) => s.onSync?.()); // components first: starts repairs of parts found broken
    for (const lane of this.entryLanes.values()) await this.pumpEntry(lane);
    if (this.cfg.closeIdleGatesOnSync) {
      const names = new Set([...this.entryLanes.values(), ...this.exitLanes.values()].map((l) => l.gate).filter(Boolean));
      for (const name of names) await this.closeGateIfIdle(name);
    }
  }

  /** The simulator reads settings.json when it starts: a new value there means it was
   * restarted at another speed, so stays learned at the old speed no longer apply. */
  private refreshSimSettingsSpeed() {
    const speed = readSimGameSpeed(this.cfg.simSettingsFile);
    if (this.clock.setSettingsSpeed(speed)) this.note("info", `simulator settings.json game speed is now ${speed}; relearning`);
  }

  private upsertSpot(s: SimParkingSpot) {
    const previous = this.spots.get(s.name);
    const oldBroken = previous?.broken;
    const oldMaintenance = previous?.maintenance;
    const spot = previous ?? new Spot(s.name, s.zoneParent || "", s.purpose, s.parkingForCarType || CarType.Any);
    spot.broken = s.broken;
    spot.maintenance = s.isUnderMaintenance;
    spot.detected = Number(s.detectedCars) || 0; // a count on Level 1, not a list of plates
    this.spots.set(spot.name, spot);
    if (previous && (oldBroken !== s.broken || oldMaintenance !== s.isUnderMaintenance)) {
      this.note("info", `spot ${s.name} sync state: ${s.broken ? "BROKEN" : s.isUnderMaintenance ? "MAINTENANCE" : "available"}`);
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
      car.charge_parking = Number(a.args[1]);
      car.charge_electric = Number(a.args[2]) || 0;
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
        const exit = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
        if (exit) { if (!exit.queue.includes(plate)) exit.queue.push(plate); exit.releasing.add(plate); exit.active ??= plate; }
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
      if (s.detected && !s.occupants.size) {
        s.occupants.add("?");
      } else if (!s.detected && s.occupants.size) {
        for (const p of s.occupants) {
          const car = this.cars.get(p);
          if (car && car.status === "parked") this.cars.delete(car.plate);
        }
        s.occupants.clear();
      }
    }
    for (const car of [...this.cars.values()]) {
      const sensor = car.exit_lane ? this.spots.get(car.exit_lane) : undefined;
      if (AT_EXIT.includes(car.status) && car.exit_lane) {
        const lane = this.exitLanes.get(car.exit_lane);
        this.restoreInvoice(car);
        if (lane && !lane.queue.includes(car.plate)) lane.queue.push(car.plate);
        if (lane && car.status === "released") lane.releasing.add(car.plate);
        if (lane && !lane.active) lane.active = car.plate;
        if (lane && lane.active === car.plate) car.passage_id ??= entityId("passage", car.visit_id, lane.spot);
        // A list snapshot cannot prove that a payment-position sensor is empty after a
        // restart. Preserve the visit and require recovery instead of deleting a paid car.
        if (!sensor?.detected && car.status === "released") car.unknown_reason ??= "exit sensor state was unavailable during recovery";
        if (car.status === "at_exit") this.scheduleCharge(car.plate, this.cfg.exitChargeDelayGameS);
        else if (car.status === "released") await this.release(car);
      }
      else if (car.status === "released") await this.release(car);
      else if (DEAD.includes(car.status)) this.cars.delete(car.plate);
    }
  }

  private reconcileLanes() {
    const now = this.clock.now();
    // A car sent to a spot just before a restart is still driving there: keep its
    // reservation. (Clearing it let the next car be sent to the same spot - two cars in
    // one spot, and a fine for every car sent there after.)
    const onTheWay = (plate: string | null) => {
      const car = plate ? this.cars.get(plate) : undefined;
      return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering");
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

    await this.each("beforeEvent", (s) => s.onBeforeEvent?.(e));
    switch (e.EventClass) {
      case EventClass.CarSpotAction: await this.routeCarEvent(e); break;
      case EventClass.GateAction: await this.onGate(e); break;
      case EventClass.PaymentMade: await this.onPayment(e); break;
      case EventClass.ComponentBroken: await this.onComponent(e, true); break;
      case EventClass.ComponentFixed: await this.onComponent(e, false); break;
      case EventClass.Penalty: await this.onPenalty(e); break;
    }
    await this.each("onEvent", (s) => s.onEvent?.(e));
    // Stale-record detection (sweepGhosts) measures silence from here.
    const car = this.cars.get(str(e, "CarPlateNumber") ?? "");
    if (car) car.lastSeenG = this.gameAt(e);
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
      visit_id: visitIdFor(e), run_id: this.runId, entry_lane: lane.spot, arrived_at: e.ServerDateTime ?? null, arrivedG: this.gameAt(e),
    });
    this.cars.set(plate, car);
    this.counters.arrived++;
    this.recentPaid.delete(plate); // came in through an entry: a new visit, billed normally
    if (this.replaying) { // what happened next is in the recorded commands
      lane.queue.push(plate);
      return;
    }
    if (lane.closed) return this.turnAway(car, `entrance ${lane.spot} is closed`);

    // Spots are reserved at dispatch time, so every car already queued for the same
    // pool of spots still needs one.
    const free = this.allocator.candidates(car.car_type, lane.zone, this.spots.values())
      .filter((s) => !this.isZoneRestricted(s.zone)).length;
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
    const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
    if (lane.gate && (!gate || !gate.operable)) return; // held; onComponent() pumps again once fixed
    const plate = lane.queue.shift()!;
    const car = this.cars.get(plate)!;
    const spot = this.allocator.choose(car.car_type, lane.zone,
      [...this.spots.values()].filter((s) => !this.isZoneRestricted(s.zone)));
    if (!spot) {
      await this.turnAway(car, "no suitable spot");
      return this.pumpEntry(lane);
    }
    spot.reserved_for = plate;
    car.reservation_id ??= entityId("reservation", car.visit_id, spot.name);
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
    if (plate === lane.current) {
      lane.current = null;
      if (car?.status === "turned_away") this.finish(car, e);
      else if (car) car.status = "entering";
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
    const unavailable = spot.broken || spot.maintenance;
    this.note(unavailable ? "error" : "info", `${plate} parked in ${name} ` +
      `(zone=${spot.zone || "-"}, type=${spot.car_type}, occupants=${spot.occupants.size}${unavailable ? ", component unavailable" : ""})`);
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
    // Replay reconstructs state from a prior wall-clock interval. Those stays may
    // cross a simulator restart or speed change and must not recalibrate the new
    // process; only live confirmed stays are valid speed evidence.
    if (!this.replaying) this.clock.addStay(car.planned_minutes, car.parkedA, car.leftSpotA);
    // Only advance the state. From a spot right next to an exit (S15 on Level 1) the
    // exit CarIn arrives ~0.2s BEFORE this CarOut; overwriting "at_exit" here would
    // cancel the pending charge and the car escapes unpaid.
    if (car.status === "parked" || car.status === "unknown") car.status = "to_exit";
    this.note("info", `${plate} left ${name} (remaining occupants=${spot?.occupants.size ?? 0}, available=${spot?.available ?? false})`);
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
    return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering");
  }

  private async onExitIn(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    if (this.drivingIn(plate)) {
      return;
    }
    const car = this.cars.get(plate) ?? this.adopt(e);
    car.exit_lane = lane.spot;
    car.exit_at = e.ServerDateTime ?? null;
    this.restoreInvoice(car);
    // A car at the exit is no longer in its spot, whether or not we saw it leave. (From a
    // spot next to the exit the spot CarOut simply arrives ~0.2s later; if it was lost,
    // this is what frees the spot.)
    const held = car.spot ? this.spots.get(car.spot) : undefined;
    if (held?.occupants.has(plate)) {
      held.occupants.delete(plate);
      for (const l of this.entryLanes.values()) await this.pumpEntry(l);
    }
    if (!lane.queue.includes(plate)) lane.queue.push(plate);
    if (lane.active && lane.active !== plate) {
      // A follower has reached the payment sensor too. Keep it in the exit
      // queue as chargeable state; when the head clears, startNextExit must
      // be able to invoice it rather than leaving it stranded as to_exit.
      if (car.charge_parking === null && car.status !== "unknown") car.status = "at_exit";
      this.note("info", `${plate} is waiting behind ${lane.active} at ${lane.spot}; no second passage is granted`);
      return;
    }
    lane.active ??= plate;
    car.passage_id ??= entityId("passage", car.visit_id, lane.spot);
    if (car.charge_parking !== null) {
      if (car.payment_ok) await this.release(car); // already invoiced: never charge twice
      return;
    }
    if (car.entry_lane === null && this.recentPaid.has(plate)) {
      // Paid moments ago and never came back through an entry: the same session looping
      // (seen with cars restored from a simulator save), not a new one.
      this.counters.repeat_exits++;
      this.note("warn", `${plate} back at ${lane.spot} after paying, without entering - not billing again, releasing`);
      car.payment_ok = true;
      return this.release(car);
    }
    if (car.status === "unknown" || (car.entry_lane === null && car.planned_minutes === null && !car.parked_at)) {
      car.unknown_reason = "no accepted arrival, parking, or planned-duration history for this visit";
      car.status = "unknown";
      this.store.createIncident({ status: "open", kind: "unknown_visit", visit_id: car.visit_id ?? null,
        reason: car.unknown_reason, confidence: "high", evidence: { plate, exit: lane.spot, event: e } });
      this.note("warn", `${plate} reached ${lane.spot} without trustworthy parking history - holding the exit for review`);
      return;
    }
    car.status = "at_exit";
    // Charging the instant the sensor fires is rejected ("Car should be charged at the
    // exit"): give the car a moment to settle on the exit spot.
    if (car.charge_attempts === 0) this.scheduleCharge(plate, this.cfg.exitChargeDelayGameS);
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
    car.charge_attempts++;
    const gameS = this.parkedGameSeconds(car);
    let parking: number, basis: string;
    if (car.charge_override !== null) {
      parking = car.charge_override;
      basis = "admin-approved adjustment";
    } else {
      if (gameS === null && !car.planned_minutes) {
        car.status = "unknown";
        car.unknown_reason = "invoice requires operator-reviewed duration";
        this.store.createIncident({ status: "open", kind: "unknown_visit", visit_id: car.visit_id ?? null,
          reason: car.unknown_reason, confidence: "high", evidence: { plate, stage: "charge" } });
        this.note("warn", `${plate}: refusing to invent a parking duration`);
        return;
      }
      parking = parkingCost(gameS ?? 0, car.planned_minutes, car.car_type, this.cfg);
      basis = car.billing_basis === "operator-approved duration"
        ? "operator-approved duration"
        : `trusted planned duration; measured ${gameS !== null ? (gameS / 60).toFixed(2) : "?"} game-min`;
    }
    const electric = chargingCost(car.car_type, this.cfg);
    if (car.billing_basis !== "operator-approved duration" && car.billing_basis !== "admin-approved adjustment") car.billing_basis = basis;
    car.invoice_id ??= entityId("invoice", car.visit_id, "parking");
    this.store.createInvoice({ invoiceId: car.invoice_id, visitId: car.visit_id ?? null, plate, parkingAmount: parking, electricAmount: electric, basis });
    if (await this.cmd("charge", () => this.sim.carCharge(plate, parking, electric), [plate, parking, electric])) {
      car.charge_parking = parking;
      car.charge_electric = electric;
      car.status = "invoiced";
      this.store.updateInvoiceStatus(car.invoice_id, "issued");
      this.note("info", `${plate} invoiced ${(parking + electric).toFixed(2)} (${basis})`);
    } else if (this.lastCommandOutcome === "unknown") {
      // The invoice is durable and the simulator may have accepted the charge even
      // though the HTTP response was lost. Treat a later matching payment as evidence,
      // but never submit the charge again automatically.
      car.charge_parking = parking;
      car.charge_electric = electric;
      car.status = "invoiced";
      this.store.updateInvoiceStatus(car.invoice_id, "outcome_unknown");
      this.note("error", `${plate} charge outcome is unknown; invoice preserved and no blind retry will be sent`);
    } else {
      this.store.updateInvoiceStatus(car.invoice_id, "rejected");
    }
    // On an HTTP failure we do NOT retry: the charge may have registered, and a second
    // one is a penalty. A rejection arrives as a penalty event instead (onPenalty).
  }

  /** How long the car was parked, in game time. */
  private parkedGameSeconds(car: Car): number | null {
    if (car.parkedG !== null && car.leftSpotG !== null) {
      const gameS = car.leftSpotG - car.parkedG;
      return gameS >= 0 ? gameS : null;
    }
    const realS = simSecondsBetween(car.parked_at, car.left_spot_at); // wall-clock stamps
    return realS === null ? null : realS * this.timeScale;
  }

  private async onPayment(e: EventRecord) {
    const plate = str(e, "CarPlateNumber")!;
    const amount = Number(e.Amount) || 0;
    const car = this.cars.get(plate);
    if (car && car.charge_parking === null) this.restoreInvoice(car);
    if (!car || car.charge_parking === null) {
      this.note("warn", `payment ${amount.toFixed(2)} from ${plate} with no invoice - ignored`);
      return;
    }
    const expected = car.charge_parking + (car.charge_electric ?? 0);
    const firstPayment = car.paid === null;
    if (!firstPayment && Math.abs((car.paid ?? 0) - amount) <= this.cfg.paymentTolerance) return;
    if (car.payment_ok) {
      // A settled visit must not be moved back into a mismatch state by a later
      // forged or duplicate amount. Keep the physical passage decision monotonic.
      this.store.recordPayment({ eventId: e.EventId ? String(e.EventId) : null, invoiceId: car.invoice_id ?? null,
        visitId: car.visit_id ?? null, plate, amount, accepted: false });
      this.store.createIncident({ status: "open", kind: "payment_after_settlement", visit_id: car.visit_id ?? null,
        zone: car.exit_lane ? this.exitLanes.get(car.exit_lane)?.zone ?? null : null,
        reason: `payment ${amount.toFixed(2)} arrived after a settled payment of ${(car.paid ?? 0).toFixed(2)}`,
        confidence: "high", evidence: { plate, amount, settled: car.paid } });
      this.note("error", `${plate} sent a different payment after settlement; ignored for release state`);
      return;
    }
    car.paid = amount;
    if (Math.abs(amount - expected) <= this.cfg.paymentTolerance) {
      car.payment_ok = true;
      if (firstPayment && !car.paymentRecorded) { this.counters.revenue += amount; car.paymentRecorded = true; }
      this.store.recordPayment({ eventId: e.EventId ? String(e.EventId) : null, invoiceId: car.invoice_id ?? null, visitId: car.visit_id ?? null,
        plate, amount, accepted: true });
      const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
      if (lane?.active === car.plate) await this.release(car);
      else car.status = "invoiced"; // payment is valid, but the physical passage is still owned by the head
    } else {
      car.payment_ok = false;
      car.status = "payment_mismatch";
      this.counters.payment_mismatches++;
      this.store.recordPayment({ eventId: e.EventId ? String(e.EventId) : null, invoiceId: car.invoice_id ?? null, visitId: car.visit_id ?? null,
        plate, amount, accepted: false });
      this.note("error", `${plate} paid ${amount.toFixed(2)}, invoice ${expected.toFixed(2)} - NOT releasing`);
    }
  }

  async release(car: Car): Promise<void> {
    if (this.replaying) return; // whether it was released is in the recorded commands
    if (car.status !== "released") {
      car.status = "released";
      car.releasedG = this.clock.now();
      car.gotoResends = 0;
    }
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (lane && lane.active !== car.plate) {
      if (!lane.queue.includes(car.plate)) lane.queue.push(car.plate);
      this.note("info", `${car.plate} is paid but waits for the active passage on ${lane.spot}`);
      return;
    }
    lane?.releasing.add(car.plate);
    const gate = lane?.gate ? this.gates.get(lane.gate) : undefined;
    const leave = () => this.leavePark(car);
    if (lane?.gate && (!gate || !gate.operable)) {
      // Not told to leave yet (gotoG null): the gate is free to be repaired, no goto to
      // re-send, and resume() releases it once the gate is fixed.
      car.gotoG = null;
      this.note("warn", `exit gate ${lane.gate} not operable - ${car.plate} waits`);
      return;
    }
    if (gate) await this.whenGateOpen(gate, leave);
    else await leave();
  }

  private async onExitOut(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    if (this.drivingIn(plate)) return; // passing over the exit sensor on the way to its spot
    const car = this.cars.get(plate) ?? this.adopt(e);
    const authorized = lane.active === plate && car.status === "released";
    if (!authorized) {
      this.counters.escaped++;
      this.note("error", `${plate} left without being released (status ${car.status})`);
      this.store.createIncident({ status: "open", kind: "unverified_exit", zone: lane.zone || null, visit_id: car.visit_id ?? null,
        reason: "exit sensor reported a departure without the active authorized passage", confidence: "medium",
        evidence: { plate, lane: lane.spot, status: car.status } });
    }
    lane.releasing.delete(plate);
    lane.queue = lane.queue.filter((p) => p !== plate);
    if (lane.active === plate) { lane.active = null; lane.recovery = false; }
    this.counters.exited++;
    this.finish(car, e);
    this.later(this.cfg.gateCloseDelayGameS, `close ${lane.gate}`, () => this.closeGateIfIdle(lane.gate));
    this.later(this.cfg.gateCloseDelayGameS + this.cfg.gateConfirmGameS, `next exit ${lane.spot}`, () => this.startNextExit(lane));
  }

  /** Rehydrate a durable invoice intent before deciding whether to charge again. */
  private restoreInvoice(car: Car): void {
    if (car.charge_parking !== null) return;
    const invoice = this.store.findInvoice(car.visit_id, car.plate);
    if (!invoice || !["intended", "issued", "outcome_unknown", "settled"].includes(invoice.status)) return;
    car.invoice_id = invoice.invoice_id;
    car.charge_parking = invoice.parking_amount;
    car.charge_electric = invoice.electric_amount;
    car.billing_basis = invoice.basis;
    if (car.status === "at_exit" || car.status === "unknown") car.status = "invoiced";
    if (invoice.status === "intended") this.store.updateInvoiceStatus(invoice.invoice_id, "outcome_unknown");
    this.note("warn", `${car.plate} restored invoice ${invoice.invoice_id} after restart/uncertain charge response`);
  }

  /** Start the next head only after the previous physical passage has cleared. */
  private async startNextExit(lane: ExitLane): Promise<void> {
    if (lane.active || lane.recovery) return;
    const plate = lane.queue[0];
    if (!plate) return;
    const car = this.cars.get(plate);
    if (!car) { lane.queue.shift(); return this.startNextExit(lane); }
    lane.active = plate;
    car.passage_id ??= entityId("passage", car.visit_id, lane.spot);
    if (car.status === "unknown") return;
    if (car.payment_ok) await this.release(car);
    else if (["at_exit", "to_exit"].includes(car.status) && car.charge_attempts === 0) {
      car.status = "at_exit";
      this.scheduleCharge(car.plate, this.cfg.exitChargeDelayGameS);
    }
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
    car.charge_parking = car.charge_electric = null;
    car.charge_override = override;
    car.invoice_id = entityId("invoice", car.visit_id, `retry-${car.charge_attempts + 1}`);
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
    // Operating a broken or under-repair gate is a penalty. Whoever waits on it stays in
    // onOpen; resume() asks again once it is fixed.
    if (!gate.operable) return;
    const clean = gate.state === GateState.Closed, sent = this.clock.real();
    if (await this.cmd("open", () => this.sim.openGate(gate.name), [gate.name])) {
      gate.state = GateState.Opening;
      gate.openRequestedAt = this.clock.now();
      gate.closeRequestedAt = null;
      gate.moveSentReal = clean ? sent : null;
    }
  }

  private async requestClose(gate: Gate) {
    const clean = gate.state === GateState.Open, sent = this.clock.real();
    if (await this.cmd("close", () => this.sim.closeGate(gate.name), [gate.name])) {
      gate.state = GateState.Closing;
      gate.closeRequestedAt = this.clock.now();
      gate.moveSentReal = clean ? sent : null;
    }
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
      if (!gate.operable) continue; // broken or being repaired: never touch it
      if (gate.onOpen.length && gate.openRequestedAt !== null && now - gate.openRequestedAt >= this.cfg.gateConfirmGameS) {
        if (gate.openRetries === 0) {
          gate.openRetries = 1;
          this.note("warn", `${gate.name} did not confirm opening, re-sending open`);
          await this.requestOpen(gate);
        } else {
          this.note("warn", `${gate.name} still unconfirmed, assuming it is open`);
          gate.state = GateState.Open;
          await this.gateOpened(gate);
        }
      } else if (gate.state === GateState.Closing && gate.closeRequestedAt !== null &&
          now - gate.closeRequestedAt >= this.cfg.gateConfirmGameS) {
        gate.closeRequestedAt = null; // one re-send only
        if (gate.hold === "open" || gate.onOpen.length || this.gateBusy(gate.name) || !gate.operable) continue;
        this.note("warn", `${gate.name} did not confirm closing, re-sending close`);
        if (await this.cmd("close", () => this.sim.closeGate(gate.name), [gate.name])) gate.moveSentReal = null;
      }
    }
  }

  gateBusy(name: string): boolean {
    return [...this.entryLanes.values()].some((l) => l.gate === name && (l.current || l.queue.length)) ||
      [...this.exitLanes.values()].some((l) => l.gate === name && l.releasing.size > 0);
  }

  async closeGateIfIdle(name: string | null): Promise<void> {
    const gate = name ? this.gates.get(name) : undefined;
    if (gate && gate.operable && gate.hold !== "open" && !this.gateBusy(gate.name) && !gate.onOpen.length &&
        (gate.state === GateState.Open || gate.state === GateState.Opening)) {
      this.note("info", `closing idle gate ${gate.name}`);
      await this.requestClose(gate);
    }
  }

  /** Environment is a serial subsystem; admission checks consult it without polling. */
  isZoneRestricted(zone: string): boolean {
    return this.subsystems.some((s) => s.isZoneRestricted?.(zone) === true);
  }

  /** Gates and spots keep their own flags; the components subsystem records the rest
   * (history, usage) and starts the repair. */
  private async onComponent(e: EventRecord, broken: boolean) {
    const name = str(e, "Name") ?? "", kind = str(e, "Type");
    const target = kind === ComponentType.BarrierGate ? this.gates.get(name)
      : kind === ComponentType.ParkingSpot ? this.spots.get(name) : undefined;
    if (kind === ComponentType.ParkingSpot) {
      const spot = target as Spot | undefined;
      if (!spot) {
        this.note("warn", `ParkingSpot ${name} ${broken ? "broke" : "was fixed"}, but it is not in the loaded layout`);
        return;
      }
      spot.broken = broken;
      if (!broken) spot.maintenance = false;
      this.note(broken ? "error" : "info", `ParkingSpot ${name} ${broken ? "BROKEN" : "fixed"} ` +
        `(zone=${spot.zone || "-"}, occupant=${spot.occupant ?? "-"}, reserved=${spot.reserved_for ?? "-"})`);
      if (broken) await this.rerouteFromBrokenSpot(spot);
      else await this.resume();
      return;
    }
    if (target) {
      target.broken = broken;
      if (!broken) target.maintenance = false;
    }
    if (!broken) {
      this.note("info", `${kind} ${name} fixed`);
      await this.resume();
    }
  }

  /** Why a gate cannot be worked on right now: a car is driving through it. */
  gateInUse(name: string): string | null {
    for (const lane of this.entryLanes.values()) {
      const car = lane.gate === name && lane.current ? this.cars.get(lane.current) : undefined;
      if (car?.status === "dispatched") return `${car.plate} is driving through`;
    }
    for (const lane of this.exitLanes.values()) {
      if (lane.gate !== name) continue;
      for (const plate of lane.releasing) {
        const car = this.cars.get(plate);
        // Told to leave after it was released: it is on its way through the gate.
        if (car?.status === "released" && car.gotoG !== null && car.releasedG !== null && car.gotoG >= car.releasedG) {
          return `${plate} is driving out`;
        }
      }
    }
    return null;
  }

  /** A part is back in service: restart what waited for it - queued arrivals, cars
   * waiting on a gate to open, paid cars waiting at an exit. */
  async resume(): Promise<void> {
    if (this.replaying) return;
    for (const gate of this.gates.values()) {
      if (gate.operable && gate.onOpen.length && gate.state !== GateState.Open && gate.state !== GateState.Opening && gate.hold !== "closed") {
        await this.requestOpen(gate);
      }
    }
    for (const lane of this.exitLanes.values()) {
      for (const plate of [...lane.releasing]) {
        const car = this.cars.get(plate);
        const waiting = car?.status === "released" && (car.gotoG === null || car.releasedG === null || car.gotoG < car.releasedG);
        if (waiting) await this.release(car!);
      }
    }
    for (const lane of this.entryLanes.values()) await this.pumpEntry(lane);
  }

  /** A spot can fail while a car is reserved for it but has not reached it yet. */
  private async rerouteFromBrokenSpot(spot: Spot): Promise<void> {
    const plate = spot.reserved_for;
    if (!plate) return;
    const car = this.cars.get(plate);
    const lane = car?.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
    if (!car || !lane || lane.current !== plate || !MID_ENTRY.includes(car.status)) {
      spot.reserved_for = null;
      this.note("warn", `${spot.name} broke with reservation for ${plate}, but no active dispatch was found`);
      return;
    }
    const alternative = this.allocator.choose(car.car_type, lane.zone, this.spots.values());
    if (alternative) {
      spot.reserved_for = null;
      alternative.reserved_for = plate;
      car.spot = alternative.name;
      car.gotoResends = 0;
      car.dispatchedG = this.clock.now();
      this.note("warn", `${spot.name} broke while ${plate} was entering; rerouting to ${alternative.name}`);
      await this.sendToSpot(plate, lane);
      return;
    }
    this.note("error", `${spot.name} broke while ${plate} was entering; no compatible spare spot`);
    spot.reserved_for = null;
    car.spot = null;
    await this.turnAway(car, `no compatible replacement for broken spot ${spot.name}`);
  }

  // ---------------------------------------------------------------------------
  // housekeeping
  // ---------------------------------------------------------------------------
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const t of this.timers.filter((t) => t.due <= now)) await this.runTimer(t);
    await this.checkGateTimeouts(now);
    await this.checkStuckGotos(now);
    await this.sweepGhosts(now);
    await this.each("onTick", (s) => s.onTick?.(now));
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
      visit_id: visitIdFor(e), run_id: this.runId, unknown_reason: "visit was observed without an accepted arrival record",
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
      lane.releasing.delete(car.plate);
      lane.queue = lane.queue.filter((plate) => plate !== car.plate);
      if (lane.active === car.plate) {
        lane.active = null;
        lane.recovery = false;
      }
    }
  }

  /** Remove a stale record without keeping it (the plate is reused by a new car). */
  private forget(car: Car) {
    this.detach(car);
    this.cars.delete(car.plate);
  }

  /** Close a car record whose closing event never arrived, and store it as a session. */
  private retire(car: Car, why: string, status: CarStatus = "lost") {
    this.note("warn", `${car.plate} ${why} - closing its record (event lost or simulator restarted)`);
    this.detach(car);
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
    const exitsToAdvance = new Set<ExitLane>();
    const retiredBefore = this.counters.ghosts_retired;
    // All in game time: a speed change or a paused game does not age anyone early.
    for (const car of [...this.cars.values()]) {
      const quietFor = now - (car.lastSeenG ?? car.arrivedG ?? now);
      if (car.status === "released" && car.releasedG !== null && now - car.releasedG > this.cfg.releaseTimeoutGameS) {
        const gate = car.exit_lane ? this.exitLanes.get(car.exit_lane)?.gate : null;
        const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
        if (lane) lane.recovery = true;
        this.store.createIncident({ status: "open", kind: "missing_exit_event", visit_id: car.visit_id ?? null,
          zone: lane?.zone || null, reason: "paid passage timed out without a confirmed exit event", confidence: "medium",
          evidence: { plate: car.plate, exit: car.exit_lane } });
        this.retire(car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
        if (gate) gatesToClose.add(gate);
        if (lane) exitsToAdvance.add(lane);
      } else if (car.status === "parked") {
        const since = car.parkedG ?? car.lastSeenG;
        const allowed = (car.planned_minutes ?? 0) * 60 + this.cfg.parkedOverstayGameS;
        if (since !== null && now - since > allowed) this.retire(car, `is still recorded in ${car.spot} well past its planned ${car.planned_minutes}m`);
      } else if (car.status === "queued") {
        if (now - (car.arrivedG ?? now) > this.cfg.entryPatienceGameS + 60) this.retire(car, `is still queued at ${car.entry_lane} past the give-up time`);
      } else if (["to_exit", "at_exit", "invoiced", "payment_mismatch", "entering", "unknown", "turned_away"].includes(car.status)) {
        if (quietFor > this.cfg.staleCarGameS) {
          const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
          this.retire(car, `has had no events for ${Math.round(quietFor)} game-s (status ${car.status})`,
            car.status === "turned_away" ? "turned_away" : "lost");
          if (lane) exitsToAdvance.add(lane);
        }
      }
    }
    for (const gate of gatesToClose) await this.closeGateIfIdle(gate);
    // Retiring a stale exit head removes an event-log record, but it must also
    // release the physical passage owner so the next car can be billed/released.
    for (const lane of exitsToAdvance) await this.startNextExit(lane);
    if (this.counters.ghosts_retired > retiredBefore) {
      for (const lane of this.entryLanes.values()) await this.pumpEntry(lane); // spots/lanes freed
    }
  }

  private finish(car: Car, e: EventRecord) {
    car.left_at = e.ServerDateTime ?? null;
    if (!["neglected", "turned_away", "lost"].includes(car.status)) car.status = "gone";
    if (car.payment_ok) this.recentPaid.set(car.plate, this.clock.now());
    const session: SessionView = { ...publicCar(car), run_id: car.run_id, visit_id: car.visit_id,
      reservation_id: car.reservation_id, passage_id: car.passage_id, invoice_id: car.invoice_id,
      unknown_reason: car.unknown_reason, billing_basis: car.billing_basis,
      parked_seconds: simSecondsBetween(car.parked_at, car.left_spot_at) };
    this.completed.push(session);
    if (this.completed.length > this.cfg.completedSessionsSize) this.completed.shift();
    if (!this.replaying) this.store.recordSession(session); // already stored the first time round
    this.cars.delete(car.plate);
  }

  async cmd(what: string, fn: () => Promise<void>, args: (string | number)[], actor: string | null = null): Promise<boolean> {
    if (this.replaying) { this.lastCommandOutcome = "ok"; return true; } // the command was sent the first time round
    const t0 = performance.now();
    let ok = true, error: string | null = null;
    this.lastCommandOutcome = "ok";
    try {
      await fn();
    } catch (ex) {
      ok = false;
      error = (ex as Error).message ?? String(ex);
      this.lastCommandOutcome = ex instanceof SimError && ex.outcomeUnknown ? "unknown" : "failed";
      this.counters.command_errors++;
      this.note("error", `command ${what}(${args.join(", ")}) failed: ${error}`);
    }
    this.store.recordAction({
      at: new Date().toISOString(), cmd: what, args: args.map(String), ok, error,
      ms: Math.round((performance.now() - t0) * 10) / 10, actor,
    });
    return ok;
  }

  note(level: FeedLevel, msg: string): void {
    if (this.replaying) return;
    this.feed.push({ at: new Date().toISOString(), level, msg });
    if (this.feed.length > this.cfg.feedSize) this.feed.shift();
    this.log[level === "warn" ? "warn" : level === "error" ? "error" : "info"](msg);
  }

  private carByVisit(identifier: string): Car | undefined {
    return this.cars.get(identifier) ?? [...this.cars.values()].find((c) => c.visit_id === identifier);
  }

  /** Operator evidence for an unknown manually parked visit; no silent fallback duration. */
  async reviewUnknownVisit(identifier: string, durationMinutes: number, reason: string, actor: string): Promise<ControlResult> {
    const car = this.carByVisit(identifier);
    if (!car) return fail(`unknown visit ${identifier}`);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 7 * 24 * 60) return fail("duration must be between 1 minute and 7 days");
    if (!reason.trim()) return fail("an evidence reason is required");
    car.planned_minutes = Math.round(durationMinutes);
    car.unknown_reason = null;
    car.billing_basis = "operator-approved duration";
    car.status = "at_exit";
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (lane && !lane.queue.includes(car.plate)) lane.queue.push(car.plate);
    if (lane && !lane.active) lane.active = car.plate;
    if (lane?.active === car.plate) this.scheduleCharge(car.plate, this.cfg.exitChargeDelayGameS);
    return ok(`duration recorded for ${car.plate}; invoice will be issued when its passage is active`);
  }

  /** Admin-only financial correction. The route enforces the permission; the engine records the basis. */
  async adjustVisit(identifier: string, amount: number, reason: string, actor: string): Promise<ControlResult> {
    const car = this.carByVisit(identifier);
    if (!car) return fail(`unknown visit ${identifier}`);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return fail("amount must be a finite nonnegative value");
    if (!reason.trim()) return fail("a reason is required for a financial adjustment");
    car.charge_override = Math.round(amount * 100) / 100;
    car.invoice_id = randomUUID();
    car.billing_basis = "admin-approved adjustment";
    car.status = "at_exit";
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    if (lane && !lane.queue.includes(car.plate)) lane.queue.push(car.plate);
    if (lane && !lane.active) lane.active = car.plate;
    if (lane?.active === car.plate) this.scheduleCharge(car.plate, this.cfg.exitChargeDelayGameS);
    return ok(`adjusted invoice for ${car.plate} to ${car.charge_override.toFixed(2)}`);
  }

  async emergencyRelease(identifier: string, reason: string, actor: string): Promise<ControlResult> {
    const car = this.carByVisit(identifier);
    if (!car) return fail(`unknown visit ${identifier}`);
    if (!reason.trim()) return fail("a reason is required for an emergency release");
    car.payment_ok = true;
    car.status = "released";
    await this.release(car);
    return ok(`emergency release authorized for ${car.plate}`);
  }

  async reportManualOccupancy(name: string, reason: string, actor: string): Promise<ControlResult> {
    const spot = this.spots.get(name);
    if (!spot || spot.purpose !== SpotPurpose.Park) return fail(`unknown parking spot ${name}`);
    if (!reason.trim()) return fail("an observation reason is required");
    spot.occupants.add("?");
    spot.maintenance = true;
    this.store.createIncident({ status: "open", kind: "manual_occupancy", zone: spot.zone || null, component: name,
      reason, confidence: "medium", evidence: { actor, spot: name } });
    return ok(`${name} quarantined until its occupancy is cleared`);
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
  async manualGate(name: string, action: GateAction, actor: string): Promise<ControlResult> {
    const gate = this.gates.get(name);
    if (!gate) return fail(`unknown gate ${name}`);
    const unusable = gate.broken ? "broken" : gate.maintenance ? "under maintenance" : null;
    const inUse = this.gateBusy(name) || gate.onOpen.length > 0;
    switch (action) {
      case "open":
      case "close": {
        if (unusable) return fail(`${name} is ${unusable} - operating it now is a penalty`);
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
        gate.hold = null;
        if (gate.onOpen.length && gate.operable) await this.requestOpen(gate); // cars were waiting on it
        else await this.closeGateIfIdle(name);
        this.note("info", `${actor} returned ${name} to automatic`);
        return ok(`${name} is automatic again`);
      }
      case "repair": {
        if (gate.maintenance) return fail(`${name} is already under maintenance`);
        if (inUse) return fail(`${name} is in use - repairing it now is a penalty`);
        if (!(await this.cmd("repair", () => this.sim.repairGate(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
        gate.maintenance = true;
        this.components.repairStarted("gate", name, actor, !gate.broken);
        this.note("warn", `${actor} started maintenance on ${name}`);
        return ok(`maintenance started on ${name}`);
      }
    }
  }

  async manualSpotRepair(name: string, actor: string): Promise<ControlResult> {
    const spot = this.spots.get(name);
    if (!spot || spot.purpose !== SpotPurpose.Park) return fail(`unknown parking spot ${name}`);
    if (spot.maintenance) return fail(`${name} is already under maintenance`);
    const who = spot.occupant ?? spot.reserved_for;
    if (who) return fail(`${name} is ${spot.occupant ? "occupied" : "reserved"}${who !== "?" ? ` by ${who}` : ""} - repairing it now is a penalty`);
    if (!(await this.cmd("repair", () => this.sim.repairSpot(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
    spot.maintenance = true; // not offered to cars until the simulator reports it fixed
    this.components.repairStarted("spot", name, actor, !spot.broken);
    this.note("warn", `${actor} started maintenance on ${name}`);
    return ok(`maintenance started on ${name}`);
  }

  async manualComponentRepair(kind: "fan" | "light", name: string, actor: string): Promise<ControlResult> {
    const part = this.components.get(kind, name);
    if (!part) return fail(`unknown ${kind} ${name}`);
    if (kind === "light") return fail("the simulator exposes no light repair endpoint; record an incident instead");
    if (part.maintenance) return fail(`${name} is already under maintenance`);
    if (await this.components.usable(kind, name) && !part.broken) {
      // Preventive work on a live fan is allowed only when it is not running.
      if (part.on) return fail(`${name} is operating - wait for it to be idle`);
    }
    if (!(await this.cmd("repair", () => this.sim.repairFan(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
    this.components.repairStarted(kind, name, actor, !part.broken);
    return ok(`maintenance started on ${name}`);
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
        available: s.available,
      }));
    return {
      synced: this.synced,
      time_scale: Math.round(this.timeScale * 1000) / 1000,
      time_scale_source: this.timeScaleInfo.source,
      topology: this.topology ? { name: this.topology.name, source: this.topology.source ?? "" } : null,
      zones,
      spots,
      gates: [...this.gates.values()].map((g) => ({ name: g.name, zone: g.zone, state: g.state, broken: g.broken, maintenance: g.maintenance, hold: g.hold })),
      entry_lanes: [...this.entryLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, queue: [...l.queue], current: l.current, closed: l.closed })),
      exit_lanes: [...this.exitLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, releasing: [...l.releasing].sort(),
        queue: [...l.queue], active: l.active, recovery: l.recovery })),
      active_cars: [...this.cars.values()].map(publicCar),
      recent_sessions: this.completed.slice(-50),
      counters: { ...this.counters },
      feed: this.feed.slice(-100),
      components: this.components.views(),
      subsystems: Object.fromEntries(this.subsystems.filter((s) => s !== this.components && s.snapshot)
        .map((s) => [s.name, s.snapshot!()])),
      environment: (this.subsystems.find((s) => s.name === "environment")?.snapshot?.() as StateSnapshot["environment"]),
      incidents: this.store.listIncidents({ status: "open", limit: 100 }),
    };
  }
}
