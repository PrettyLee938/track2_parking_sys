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
  type ComponentKind,
} from "@gpa/shared";
import { getAllocator, spotNumber, type AllocContext, type Allocator, type AllocSpot } from "./allocation";
import { chargingCost, parkingCost } from "./billing";
import { readSimGameSpeed, type Settings } from "./config";
import { ComponentRegistry } from "./components";
import { GameClock } from "./gameClock";
import type { SpotSensors } from "./sensorHealth";
import { createSubsystems, type Engine, type Subsystem } from "./subsystems";
import { SerialQueue, type TaskQueue } from "./serialQueue";
import type { SimApi } from "./simClient";
import type { ActionRecord, EventRecord, Store } from "./store";
import { matches, resolve as resolveTopology, type RouteDef, type Topology } from "./topology";

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
  /**
   * Plates physically in the spot ("?" = a car we cannot name). Normally 0 or 1 - but the
   * simulator lets a second car park in an occupied spot (it only fines it), and if we kept
   * a single plate, the first car leaving would mark the spot free while the other is
   * still in it: every car sent there next is fined too.
   */
  readonly occupants = new Set<string>();
  reserved_for: string | null = null; // plate sent here but not arrived yet
  detected = 0;                       // car count from the last list-parking-spots
  /**
   * Taken out of service by US, not by the simulator: its sensor is behaving oddly, so no
   * car is sent here until it reads clean again. Holds the reason, for the dashboard.
   * The simulator has no maintenance-mode command for a spot, so this is a soft lock;
   * see sensorHealth.ts.
   */
  out_of_service: string | null = null;

  constructor(readonly name: string, public zone: string, readonly purpose: string, readonly car_type: string) {}

  /** A named occupant if there is one, "?" for an unknown car, null when empty. */
  get occupant(): string | null {
    for (const p of this.occupants) if (p !== "?") return p;
    return this.occupants.size ? "?" : null;
  }

  get available(): boolean {
    return this.purpose === SpotPurpose.Park && !this.broken && !this.maintenance && this.out_of_service === null &&
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
  idleSinceG: number | null = null;       // open with nobody using it since (closeForgottenGates)
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
  fakePayments: number;          // payments with a bad signature
  waitingForGate: boolean;       // released, its leavepark queued until the exit gate opens
  routeGates: string[];          // entry gates on its way to its spot, in order (kept open until it parks)
  manualIncidentId: number | null;
}

function newCar(plate: string, carType: string, planned: number | null, status: CarStatus, extra: Partial<Car> = {}): Car {
  return {
    plate, car_type: carType, planned_minutes: planned, status,
    entry_lane: null, exit_lane: null, arrived_at: null, spot: null, parked_at: null, left_spot_at: null,
    exit_at: null, charge_parking: null, charge_electric: null, charge_attempts: 0, charge_override: null,
    paid: null, payment_ok: null, left_at: null,
    arrivedG: null, dispatchedG: null, parkedG: null, leftSpotG: null, releasedG: null, lastSeenG: null,
    gotoG: null, gotoResends: 0, parkedA: null, leftSpotA: null, chargeScheduled: false, fakePayments: 0, waitingForGate: false, routeGates: [], manualIncidentId: null,
    ...extra,
  };
}

export function publicCar(c: Car): CarView {
  const { arrivedG, dispatchedG, parkedG, leftSpotG, releasedG, lastSeenG, gotoG, gotoResends, parkedA, leftSpotA,
    chargeScheduled, fakePayments, waitingForGate, routeGates, manualIncidentId, ...view } = c;
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
  /** Why the parts on site are new (simulator restarted, level changed), until usage is reset. */
  private freshSite: string | null = null;
  /** "ENTRY1>ZONE2": cars from this entrance cannot reach that zone (learned from penalties). */
  readonly unreachable = new Set<string>();
  private lastParkedCheckG = -Infinity;
  /** Extra charge delay per exit (game s), learned from "should be charged at the exit" penalties. */
  private readonly chargeDelayExtra = new Map<string, number>();
  private started = false; // real timers only once running (tests drive time by hand)
  private readonly replayedIds = new Set<string>();
  private lastResyncRequest = 0;
  private readonly unresolvedSpots = new Map<string, number>(); // unknown entry/exit -> last resync
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
  /** Core: health and usage of every part (Level 2). Sees events before the plug-ins. */
  readonly components: ComponentRegistry;
  /** components first, then the plug-ins. */
  readonly subsystems: Subsystem[];

  completed: SessionView[] = [];
  feed: FeedItem[] = [];
  counters: Counters = {
    arrived: 0, admitted: 0, turned_away: 0, neglected: 0, exited: 0, revenue: 0, payment_mismatches: 0,
    repeat_exits: 0, ghosts_retired: 0, escaped: 0, penalties: 0, fines: 0, command_errors: 0, fake_payments: 0,
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
    this.queue.push(() => this.initialSync(), "initial sync");
    this.tickHandle = setInterval(() => {
      if (this.tickPending) return;
      this.tickPending = true;
      this.queue.push(async () => { this.tickPending = false; await this.tick(); }, "tick");
    }, this.cfg.tickIntervalS * 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  submit(e: EventRecord): void {
    this.queue.push(() => this.handle(e), `event ${e.EventClass}`);
  }

  /** A webhook the intake refused (bad signature): not acted on, only looked at - a refused
   * payment_made is a car trying to leave with a fake payment. */
  submitRejected(e: EventRecord): void {
    this.queue.push(() => this.onRejected(e), `rejected ${e.EventClass}`);
  }

  requestResync(): void {
    this.queue.push(() => this.sync(), "resync");
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
      this.freshSite = "the level was (re)started from the simulator's menu";
      return;
    }
    const levelChanged = this.topology !== null && !matches(this.topology, entry, exit);
    const freshLayout = !this.topology || levelChanged;
    if (levelChanged) this.freshSite = "the level changed";
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
      this.exitLanes = new Map(this.topology.exit_lanes.map((l) => [l.spot, { ...l, releasing: new Set<string>() }]));
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
    if (this.freshSite) {
      // A restarted level starts with new parts (Level 2 is not saved): counts from before
      // would make healthy gates look worn out and block them. 2026-09-20 02:26: gate1 was
      // "11 openings" from before a simulator restart - no car got in.
      this.components.resetUsage(this.freshSite);
      this.freshSite = null;
    }
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
    const spot = this.spots.get(s.name) ?? new Spot(s.name, s.zoneParent || "", s.purpose, s.parkingForCarType || CarType.Any);
    spot.broken = s.broken;
    spot.maintenance = s.isUnderMaintenance;
    spot.detected = Number(s.detectedCars) || 0; // a count on Level 1, not a list of plates
    this.spots.set(spot.name, spot);
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
      if (newest) this.freshSite = `no events for ${Math.round(nowS() - newest)}s - the simulator was likely restarted`;
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
      const invoice = this.store.findInvoice(car.visit_id, car.plate);
      car.invoice_id = invoice?.invoice_id ?? car.invoice_id ?? `invoice:${car.visit_id ?? car.plate}`;
      car.billing_basis = invoice?.basis ?? car.billing_basis;
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
        if (car.exit_lane) this.exitLanes.get(car.exit_lane)?.releasing.add(plate);
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
      if (lane && spot) car.routeGates = this.routeFor(lane, spot.zone)?.gates ?? [];
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
      if (AT_EXIT.includes(car.status) && !sensor?.detected) this.cars.delete(car.plate);
      else if (car.status === "at_exit") this.scheduleCharge(car.plate, this.chargeDelay(car.exit_lane));
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
  /** A car on its way from another entrance to a zone further down the road drives over this
   * entrance's sensor (ENTRY1 -> ZONE2 passes ENTRY2): not an arrival, not a departure. */
  private passingThrough(plate: string, lane: EntryLane): boolean {
    const car = this.cars.get(plate);
    return !!car && car.entry_lane !== lane.spot && (MID_ENTRY.includes(car.status) || car.status === "entering");
  }

  private async onEntryIn(e: EventRecord, lane: EntryLane) {
    const plate = str(e, "CarPlateNumber")!;
    if (this.passingThrough(plate, lane)) return;
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
      visit_id: e.EventId ? `visit:${e.EventId}` : undefined,
      entry_lane: lane.spot, arrived_at: e.ServerDateTime ?? null, arrivedG: this.gameAt(e),
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
    const free = this.allocator.candidates(car.car_type, lane.zone, this.spots.values(), this.allocContext(lane.spot)).length;
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
    const spot = this.allocator.choose(car.car_type, lane.zone, this.spots.values(), this.allocContext(lane.spot));
    if (!spot) {
      await this.turnAway(car, "no suitable spot");
      return this.pumpEntry(lane);
    }
    spot.reserved_for = plate;
    await this.each("reserved", (s) => s.reserved?.(spot.name, plate));
    car.spot = spot.name;
    car.status = "dispatching";
    car.dispatchedG = this.clock.now();
    car.gotoResends = 0;
    car.routeGates = this.routeFor(lane, spot.zone)?.gates ?? (lane.gate ? [lane.gate] : []);
    lane.current = plate;
    // Every gate on the way must be open before the goto: a car sent towards a closed gate
    // just stays put (03:21 run - ENTRY1 cars for ZONE2 with gate3 shut never moved).
    await this.whenGatesOpen(car.routeGates, () => this.sendToSpot(plate, lane));
  }

  /** Run fn once every one of these gates is open, opening them in driving order. */
  private async whenGatesOpen(names: string[], fn: Callback): Promise<void> {
    const [first, ...rest] = names.map((n) => this.gates.get(n)).filter((g): g is Gate => !!g);
    if (!first) return void await fn();
    await this.whenGateOpen(first, () => this.whenGatesOpen(rest.map((g) => g.name), fn));
  }

  /**
   * How a car from this entrance gets to a zone: the gates it drives through and the sensors
   * it passes (topology routes, from the level's road network). null = it cannot get there.
   * Without route data, the lane's own gate for any zone (Level 1 behaviour).
   */
  routeFor(lane: EntryLane, zone: string): RouteDef | null {
    const known = this.topology?.routes?.[lane.spot];
    if (known) return known[zone] ?? null;
    return { gates: lane.gate ? [lane.gate] : [], sensors: [lane.spot] };
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
    if (this.passingThrough(plate, lane)) return;
    const car = this.cars.get(plate);
    if (plate === lane.current && car?.status === "turned_away") {
      // Given up on and turned away (giveUpOnEntry): it has cleared the sensor.
      lane.current = null;
      this.finish(car, e);
      if (lane.queue.length) await this.pumpEntry(lane);
    } else if (plate === lane.current) {
      if (car) car.status = "entering";
      lane.current = null;
      if (lane.queue.length) await this.pumpEntry(lane);
      else this.later(this.cfg.entryGateCloseDelayGameS, `close ${lane.gate}`, () => this.closeGateIfIdle(lane.gate));
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
    // Parked: the gates further down the road it drove through (gate3 for ENTRY1 -> ZONE2) can
    // close once nobody else is on the way - held like an entry gate, across a stream of cars.
    const passed = car.routeGates.filter((g) => g !== lane?.gate);
    car.routeGates = [];
    for (const g of passed) this.later(this.cfg.entryGateCloseDelayGameS, `close ${g}`, () => this.closeGateIfIdle(g));
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
    return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering");
  }

  private async onExitIn(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    if (this.drivingIn(plate)) return;
    const known = this.cars.get(plate);
    const car = known ?? this.adopt(e);
    car.exit_lane = lane.spot;
    car.exit_at = e.ServerDateTime ?? null;
    // A car that appears at an exit without an accepted entry/spot flow may have
    // been parked manually. Never invent a parking duration and never release it
    // automatically: hold it for an operator reconciliation and keep the incident
    // visible across restarts.
    if (!known || car.status === "unknown") {
      car.status = "unknown";
      car.unknown_reason = "manual parking detected at exit without entry/spot telemetry";
      const existing = this.store.findOpenIncident("manual_parked_car", car.visit_id);
      const incident = existing ?? (!this.replaying ? this.store.createIncident({
        status: "open", kind: "manual_parked_car", zone: lane.zone, visit_id: car.visit_id,
        reason: car.unknown_reason, confidence: "high",
        evidence: { plate, exit: lane.spot, event_id: e.EventId ?? null, car_type: car.car_type },
      }) : undefined);
      car.manualIncidentId = incident?.id ?? null;
      this.note("warn", `${plate} held at ${lane.spot}: ${car.unknown_reason}`);
      return;
    }
    // A car at the exit is no longer in its spot, whether or not we saw it leave. (From a
    // spot next to the exit the spot CarOut simply arrives ~0.2s later; if it was lost,
    // this is what frees the spot.)
    const held = car.spot ? this.spots.get(car.spot) : undefined;
    if (held?.occupants.has(plate)) {
      held.occupants.delete(plate);
      for (const l of this.entryLanes.values()) await this.pumpEntry(l);
    }
    if (car.charge_parking !== null) return; // already invoiced: charging twice is a penalty
    if (car.entry_lane === null && this.recentPaid.has(plate)) {
      // Paid moments ago and never came back through an entry: the same session looping
      // (seen with cars restored from a simulator save), not a new one.
      this.counters.repeat_exits++;
      this.note("warn", `${plate} back at ${lane.spot} after paying, without entering - not billing again, releasing`);
      car.payment_ok = true;
      return this.release(car);
    }
    car.status = "at_exit";
    // Charging the instant the sensor fires is rejected ("Car should be charged at the
    // exit"): give the car a moment to settle on the exit spot.
    this.scheduleCharge(plate, this.chargeDelay(lane.spot));
  }

  /** How long to let a car settle on this exit before charging it (game s): the configured
   * delay plus whatever "should be charged at the exit" penalties there taught us. */
  chargeDelay(exit: string | null): number {
    return this.cfg.exitChargeDelayGameS + (exit ? this.chargeDelayExtra.get(exit) ?? 0 : 0);
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
      basis = car.billing_basis ?? "operator or simulator override";
    } else {
      if (gameS === null && !car.planned_minutes) this.note("warn", `${plate}: no parking times and no planned duration, billing 1 minute`);
      parking = parkingCost(gameS ?? 60, car.planned_minutes, car.car_type, this.cfg);
      basis = `planned ${car.planned_minutes}m, measured ${gameS !== null ? (gameS / 60).toFixed(2) : "?"} game-min`;
    }
    const electric = chargingCost(car.car_type, this.cfg);
    const invoiceId = car.invoice_id ?? `invoice:${car.visit_id ?? car.plate}`;
    car.invoice_id = invoiceId;
    car.billing_basis = basis;
    this.store.createInvoice({ invoiceId, visitId: car.visit_id, plate: car.plate,
      parkingAmount: parking, electricAmount: electric, basis });
    if (await this.cmd("charge", () => this.sim.carCharge(plate, parking, electric), [plate, parking, electric])) {
      car.charge_parking = parking;
      car.charge_electric = electric;
      car.status = "invoiced";
      this.store.updateInvoiceStatus(invoiceId, "issued");
      this.note("info", `${plate} invoiced ${(parking + electric).toFixed(2)} (${basis})`);
    } else {
      this.store.updateInvoiceStatus(invoiceId, "outcome_unknown");
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
    const car = this.cars.get(plate);
    if (!car || car.charge_parking === null) {
      const invoice = this.store.findInvoice(car?.visit_id, plate);
      this.store.recordPayment({ eventId: e.EventId, invoiceId: invoice?.invoice_id, visitId: car?.visit_id,
        plate, amount, accepted: false });
      this.note("warn", `payment ${amount.toFixed(2)} from ${plate} with no invoice - ignored`);
      return;
    }
    const expected = car.charge_parking + (car.charge_electric ?? 0);
    const invoice = this.store.findInvoice(car.visit_id, plate);
    car.invoice_id = car.invoice_id ?? invoice?.invoice_id ?? `invoice:${car.visit_id ?? car.plate}`;
    car.paid = amount;
    const accepted = Math.abs(amount - expected) <= this.cfg.paymentTolerance;
    this.store.recordPayment({ eventId: e.EventId, invoiceId: car.invoice_id, visitId: car.visit_id, plate, amount, accepted });
    if (accepted) {
      car.payment_ok = true;
      this.counters.revenue += amount;
      await this.release(car);
    } else {
      car.payment_ok = false;
      car.status = "payment_mismatch";
      this.counters.payment_mismatches++;
      this.note("error", `${plate} paid ${amount.toFixed(2)}, invoice ${expected.toFixed(2)} - NOT releasing`);
    }
  }

  /**
   * "Some cars will tweak the system and send fake payment" (spec). In the 2026-09-20 run six
   * payments had a bad signature; each car sat on the exit unpaid and the simulator fined us
   * every ~3 min ("escaped without paying") until it drove out. The car is never released
   * for it. It is asked once more to pay (rechargeAfterFakePayment) - its only way to pay
   * for real.
   */
  private async onRejected(e: EventRecord) {
    if (e.EventClass !== EventClass.PaymentMade) return;
    const plate = str(e, "CarPlateNumber") ?? "?";
    const car = this.cars.get(plate);
    this.counters.fake_payments++;
    const invoice = this.store.findInvoice(car?.visit_id, plate);
    this.store.recordPayment({ eventId: e.EventId, invoiceId: car?.invoice_id ?? invoice?.invoice_id,
      visitId: car?.visit_id, plate, amount: Number(e.Amount) || 0, accepted: false });
    this.note("error", `FAKE payment ${e.Amount} from ${plate} (bad signature) - not releasing`);
    if (!car || car.payment_ok || car.status !== "invoiced") return;
    car.fakePayments++;
    // Some cars fake twice in a row (04:44 run: ZLP 294, BCA 039, LCC 468 - each then sat on
    // the exit, fined every ~45 s). Asking again has never been fined, so keep asking.
    if (this.cfg.rechargeAfterFakePayment && car.fakePayments <= this.cfg.fakePaymentRecharges) {
      this.note("warn", `${plate}: asking for payment again after fake #${car.fakePayments}`);
      const amount = car.charge_parking;
      car.charge_parking = car.charge_electric = null;
      car.charge_override = amount;
      car.status = "at_exit";
      this.scheduleCharge(car.plate, this.cfg.exitChargeRetryGameS); // not limited by maxChargeAttempts (that is for rejected bills)
    } else {
      this.note("error", `${plate}: ${car.fakePayments} fake payments - holding it at ${car.exit_lane}, not letting it out unpaid`);
    }
  }

  async release(car: Car): Promise<void> {
    if (this.replaying) return; // whether it was released is in the recorded commands
    if (car.status !== "released") {
      car.status = "released";
      car.releasedG = this.clock.now();
      car.gotoResends = 0;
      // Its entry goto is history: the stuck-goto check must wait for the leavepark. (It
      // did not, and re-released cars still waiting for the gate: 49 double leaveparks.)
      car.gotoG = null;
    }
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    lane?.releasing.add(car.plate);
    const gate = lane?.gate ? this.gates.get(lane.gate) : undefined;
    if (lane?.gate && (!gate || !gate.operable)) {
      // Not told to leave yet (gotoG null): the gate is free to be repaired, no goto to
      // re-send, and resume() releases it once the gate is fixed.
      car.gotoG = null;
      this.note("warn", `exit gate ${lane.gate} not operable - ${car.plate} waits`);
      return;
    }
    if (!gate) return void await this.leavePark(car);
    if (car.waitingForGate && gate.state !== GateState.Open) return; // already queued on this gate
    car.waitingForGate = true;
    await this.whenGateOpen(gate, () => {
      car.waitingForGate = false;
      return this.leavePark(car);
    });
  }

  private async onExitOut(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    if (this.drivingIn(plate)) return; // passing over the exit sensor on the way to its spot
    const known = this.cars.get(plate);
    const car = known ?? this.adopt(e);
    if (!known) {
      car.exit_lane = lane.spot;
      car.unknown_reason = "car left through exit without entry/spot telemetry";
      const existing = this.store.findOpenIncident("manual_parked_car", car.visit_id);
      const incident = existing ?? (!this.replaying ? this.store.createIncident({
        status: "open", kind: "manual_parked_car", zone: lane.zone, visit_id: car.visit_id,
        reason: car.unknown_reason, confidence: "high",
        evidence: { plate, exit: lane.spot, event_id: e.EventId ?? null, action: "exit_without_exit_in" },
      }) : undefined);
      car.manualIncidentId = incident?.id ?? null;
    }
    if (car.status !== "released") {
      this.counters.escaped++;
      this.note("error", `${plate} left without being released (status ${car.status})`);
    }
    lane.releasing.delete(plate);
    this.counters.exited++;
    this.finish(car, e);
    this.later(this.cfg.gateCloseDelayGameS, `close ${lane.gate}`, () => this.closeGateIfIdle(lane.gate));
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
    if (lowered.includes(PenaltyReason.CannotReach)) return this.onUnreachablePenalty(car);
    if (car && lowered.includes(PenaltyReason.AlreadyPaid) && ["at_exit", "invoiced", "payment_mismatch"].includes(car.status)) {
      // Our record missed its payment (e.g. across a restart); the simulator knows it paid.
      this.note("warn", `${car.plate} has already paid according to the simulator - releasing`);
      car.payment_ok = true;
      return this.release(car);
    }
    if (!car || car.status !== "invoiced") return;
    if (lowered.includes(PenaltyReason.ChargeNotAtExit)) {
      // Rejected for timing: the car had not settled on the exit yet. Charge later there from
      // now on (04:20 run: 8 of these in 35 s, the settle time just above our delay).
      if (car.exit_lane && !this.replaying) {
        const extra = Math.min(this.cfg.exitChargeDelayMaxExtraGameS, (this.chargeDelayExtra.get(car.exit_lane) ?? 0) + 0.5);
        this.chargeDelayExtra.set(car.exit_lane, extra);
        this.note("warn", `${car.exit_lane}: charging ${this.chargeDelay(car.exit_lane).toFixed(1)} game-s after arrival from now on`);
      }
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
    await this.redirect(car, `${spot.name} is occupied`);
  }

  /**
   * "If the car cannot reach the specified spot ... a penalty will be applied" (spec). The
   * zone-spreading allocator sends cars to other zones; if the simulator says a car cannot
   * get there from its entrance, never send cars from that entrance to that zone again.
   */
  private async onUnreachablePenalty(car: Car | undefined) {
    if (this.replaying || !car?.spot || !car.entry_lane || !(MID_ENTRY.includes(car.status) || car.status === "entering")) return;
    const zone = this.spots.get(car.spot)?.zone;
    if (!zone) return;
    this.unreachable.add(`${car.entry_lane}>${zone}`);
    this.note("error", `cars from ${car.entry_lane} cannot reach ${zone} - not sending them there again`);
    const old = this.spots.get(car.spot);
    if (old?.reserved_for === car.plate) old.reserved_for = null;
    await this.redirect(car, `${car.spot} cannot be reached`);
  }

  /** Send a car that is on its way in to another spot. */
  private async redirect(car: Car, why: string) {
    const lane = car.entry_lane ? this.entryLanes.get(car.entry_lane) : undefined;
    const alt = this.allocator.choose(car.car_type, lane?.zone ?? "", this.spots.values(), this.allocContext(lane?.spot ?? null));
    if (!alt) {
      this.note("error", `${car.plate}: ${why} and no other spot is free`);
      return;
    }
    alt.reserved_for = car.plate;
    await this.each("reserved", (s) => s.reserved?.(alt.name, car.plate));
    car.spot = alt.name;
    car.gotoResends = 0;
    car.dispatchedG = this.clock.now();
    const before = car.routeGates;
    car.routeGates = lane ? this.routeFor(lane, alt.zone)?.gates ?? [] : [];
    this.note("warn", `${why} - redirecting ${car.plate} to ${alt.name}`);
    const go = async () => {
      if (car.spot !== alt.name) return; // redirected again meanwhile
      if (await this.cmd("goto", () => this.sim.carGoto(car.plate, alt.name), [car.plate, alt.name])) car.gotoG = this.clock.now();
    };
    // Gates of the new route it has not been cleared through yet (a car redirected from ZONE2
    // to ZONE1 needs none; one sent further down the road needs the next gates open).
    await this.whenGatesOpen(car.routeGates.filter((g) => !before.includes(g) || this.gates.get(g)?.state !== GateState.Open), go);
  }

  private rebill(car: Car, override: number | null) {
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
    // Operating a broken or under-repair gate is a penalty, and opening a worn-out one
    // breaks it (Level 2 gates break on their 10th opening). Whoever waits on it stays in
    // onOpen; preventive maintenance repairs a worn gate, resume() asks again once fixed.
    if (!gate.operable || await this.components.holdForRepair("gate", gate.name)) return;
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
      if (gate.onOpen.length && gate.openRequestedAt === null && gate.hold !== "closed" &&
          gate.state !== GateState.Open && gate.state !== GateState.Opening) {
        // Cars wait on a gate we held back (worn out): ask again - repairs it, or after
        // wornWaitMaxGameS opens it anyway.
        await this.requestOpen(gate);
      } else if (gate.onOpen.length && gate.openRequestedAt !== null && now - gate.openRequestedAt >= this.cfg.gateConfirmGameS) {
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
      [...this.exitLanes.values()].some((l) => l.gate === name && l.releasing.size > 0) ||
      this.inTransitThrough(name) !== null;
  }

  /** A car on its way to a zone further down the road, still to pass this gate (it is on its
   * route, and not the gate of its own entrance - that one is the lane's business). */
  private inTransitThrough(gate: string): Car | null {
    const now = this.clock.now();
    for (const car of this.cars.values()) {
      if (!car.routeGates.includes(gate) || !(MID_ENTRY.includes(car.status) || car.status === "entering")) continue;
      if (car.entry_lane && this.entryLanes.get(car.entry_lane)?.gate === gate) continue;
      // A drive down the road takes seconds; a car "on its way" for longer lost its parking
      // event - it must not hold the gate open.
      if (car.dispatchedG !== null && now - car.dispatchedG > this.cfg.transitMaxGameS) continue;
      return car;
    }
    return null;
  }

  async closeGateIfIdle(name: string | null): Promise<void> {
    const gate = name ? this.gates.get(name) : undefined;
    if (gate && gate.operable && gate.hold !== "open" && !this.gateBusy(gate.name) && !gate.onOpen.length &&
        (gate.state === GateState.Open || gate.state === GateState.Opening)) {
      await this.requestClose(gate);
    }
  }

  /** Gates and spots keep their own flags; the components subsystem records the rest
   * (history, usage) and starts the repair. */
  private async onComponent(e: EventRecord, broken: boolean) {
    const name = str(e, "Name") ?? "", kind = str(e, "Type");
    const target = kind === ComponentType.BarrierGate ? this.gates.get(name)
      : kind === ComponentType.ParkingSpot ? this.spots.get(name) : undefined;
    if (target) {
      target.broken = broken;
      if (!broken) target.maintenance = false;
    }
    // Waiting cars are resumed by the components subsystem once it has reset the part's
    // usage - resuming here, first, would find the gate still "worn out" and repair it again.
    if (!broken) this.note("info", `${kind} ${name} fixed`);
  }

  /**
   * What spot allocation should know besides the spots: per zone, how its exit gate is doing
   * (broken / under repair, and wear towards its limit - spreading cars spreads exit-gate
   * wear), whether cars from this entrance can reach it at all, and how worn each spot is.
   */
  private allocContext(entry: string | null): AllocContext {
    const gateLimit = this.components.limit("gate");
    return {
      zoneCost: (zone) => {
        if (entry && this.unreachable.has(`${entry}>${zone}`)) return null;
        let cost = 0;
        const lane = entry ? this.entryLanes.get(entry) : undefined;
        if (lane) {
          const route = this.routeFor(lane, zone);
          if (!route) return null; // no road from this entrance to that zone
          // Gates further down the road (not the lane's own): out of service = no way through
          // for now; each one working costs a cycle of wear and a longer drive.
          const extra = route.gates.filter((g) => g !== lane.gate);
          if (extra.some((g) => !this.gates.get(g)?.operable)) return null;
          cost += this.cfg.zoneRouteGateCost * extra.length;
        }
        for (const lane of this.exitLanes.values()) {
          if (lane.zone !== zone || !lane.gate) continue;
          const gate = this.gates.get(lane.gate);
          if (gate && !gate.operable) cost += this.cfg.zoneExitDownCost;
          if (gateLimit) cost += this.cfg.zoneExitWearCost * Math.min(1, (this.components.get("gate", lane.gate)?.uses ?? 0) / gateLimit);
        }
        return cost;
      },
      spotWear: (name) => this.components.get("spot", name)?.uses ?? 0,
    };
  }

  /** Why a gate cannot be worked on right now: a car is driving through it. */
  gateInUse(name: string): string | null {
    for (const lane of this.entryLanes.values()) {
      const car = lane.gate === name && lane.current ? this.cars.get(lane.current) : undefined;
      if (car?.status === "dispatched") return `${car.plate} is driving through`;
    }
    const transit = this.inTransitThrough(name);
    if (transit && transit.status !== "dispatching") return `${transit.plate} is driving through to ${transit.spot}`;
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

  // ---------------------------------------------------------------------------
  // housekeeping
  // ---------------------------------------------------------------------------
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const t of this.timers.filter((t) => t.due <= now)) await this.runTimer(t);
    await this.checkGateTimeouts(now);
    await this.checkStuckGotos(now);
    await this.sweepGhosts(now);
    await this.closeForgottenGates(now);
    await this.each("onTick", (s) => s.onTick?.(now));
    this.sample(nowS());
    const horizon = now - this.cfg.repeatExitWindowGameS;
    for (const [plate, t] of this.recentPaid) if (t < horizon) this.recentPaid.delete(plate);
  }

  /**
   * Any lane gate standing open with nobody using it is closed once its hold time is up -
   * whatever the reason no close was scheduled (a car redirected or written off on its way
   * through). 04:11 run: gate3 and gate5 stood open for minutes with no traffic through them.
   */
  private async closeForgottenGates(now: number) {
    const exitGates = new Set([...this.exitLanes.values()].map((l) => l.gate));
    const laneGates = new Set([...this.entryLanes.values(), ...this.exitLanes.values()].map((l) => l.gate).filter((g): g is string => !!g));
    for (const name of laneGates) {
      const gate = this.gates.get(name);
      if (!gate) continue;
      const idle = gate.state === GateState.Open && !gate.hold && gate.operable && !gate.onOpen.length && !this.gateBusy(name);
      if (!idle) { gate.idleSinceG = null; continue; }
      gate.idleSinceG ??= now;
      const hold = exitGates.has(name) ? this.cfg.gateCloseDelayGameS : this.cfg.entryGateCloseDelayGameS;
      if (now - gate.idleSinceG >= hold) {
        gate.idleSinceG = null;
        await this.closeGateIfIdle(name);
      }
    }
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
      const spotZone = onEntry && car.spot ? this.spots.get(car.spot)?.zone : undefined;
      // Only guess "unreachable" without route data. With routes from the level's road network
      // the answer is known, and a slow start is just a slow start: at x5.8 game speed the
      // confirm window is 0.7 real s - 04:01 run: ZONE2/3 wrongly written off, 291 cars
      // turned away while 60 spots stood empty. Re-send instead.
      const routeOpen = car.routeGates.every((g) => this.gates.get(g)?.state === GateState.Open);
      if (onEntry && !this.topology?.routes && spotZone && entry!.zone && spotZone !== entry!.zone && routeOpen) {
        // Sent to another zone and did not move: the simulator ignores a goto to a spot the
        // car cannot reach - no penalty, the car just sits on the entry sensor and blocks
        // the lane (2026-09-20 03:21: 13 of 13 ENTRY1 cars sent to ZONE2 never moved).
        this.unreachable.add(`${entry!.spot}>${spotZone}`);
        this.note("error", `cars from ${entry!.spot} cannot reach ${spotZone} (${car.plate} did not move) - keeping them in ${entry!.zone}`);
        const old = this.spots.get(car.spot!);
        if (old?.reserved_for === car.plate) old.reserved_for = null;
        await this.redirect(car, `${car.spot} is out of reach`);
        continue;
      }
      if (car.gotoResends >= this.cfg.maxGotoResends) {
        if (car.gotoResends > this.cfg.maxGotoResends) continue; // given up already (gotoG kept: the release timeout runs from it)
        car.gotoResends++;
        if (onEntry) {
          await this.giveUpOnEntry(car, entry!);
        } else {
          this.note("error", `${car.plate} still has not left ${where} after ${this.cfg.maxGotoResends} re-sent gotos`);
          if (car.status === "turned_away" && entry?.current === car.plate) { // last resort: do not hold the lane forever
            entry.current = null;
            await this.pumpEntry(entry);
          }
        }
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

  /**
   * A car that will not drive to its spot is still ON the entry sensor: dispatching the next
   * car behind it achieves nothing (2026-09-20 03:21: cars given up on kept blocking ENTRY1).
   * Turn it away instead; the lane moves on when it drives off (its entry CarOut).
   */
  private async giveUpOnEntry(car: Car, lane: EntryLane) {
    this.note("error", `${car.plate} will not drive into the car park from ${lane.spot} - turning it away to clear the lane`);
    const spot = car.spot ? this.spots.get(car.spot) : undefined;
    if (spot?.reserved_for === car.plate) spot.reserved_for = null;
    car.spot = null;
    car.gotoResends = 0;
    car.routeGates = [];
    car.status = "turned_away";
    this.counters.turned_away++;
    await this.leavePark(car); // lane.current stays: onEntryOut moves the lane on
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
    }, `timer ${timer.label}`), this.clock.realUntil(timer.due) * 1000);
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
      visit_id: e.EventId ? `manual:${e.EventId}` : undefined,
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
    for (const lane of this.exitLanes.values()) lane.releasing.delete(car.plate);
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
    const retiredBefore = this.counters.ghosts_retired;
    // All in game time: a speed change or a paused game does not age anyone early.
    const overdueParked: Car[] = [];
    for (const car of [...this.cars.values()]) {
      const quietFor = now - (car.lastSeenG ?? car.arrivedG ?? now);
      // Timed from the leavepark, not the release: a paid car waiting for its exit gate to come
      // back from a repair (~35 s) has not been told to leave yet. Writing it off (03:04) left
      // it stranded - nobody released it once the gate was fixed.
      const leaveSent = car.gotoG !== null && car.releasedG !== null && car.gotoG >= car.releasedG ? car.gotoG : null;
      if (car.status === "released" && leaveSent !== null && now - leaveSent > this.cfg.releaseTimeoutGameS) {
        const gate = car.exit_lane ? this.exitLanes.get(car.exit_lane)?.gate : null;
        this.retire(car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
        if (gate) gatesToClose.add(gate);
      } else if (car.status === "parked") {
        const since = car.parkedG ?? car.lastSeenG;
        const allowed = (car.planned_minutes ?? 0) * 60 + this.cfg.parkedOverstayGameS;
        if (since !== null && now - since > allowed) overdueParked.push(car);
      } else if (car.status === "queued") {
        if (now - (car.arrivedG ?? now) > this.cfg.entryPatienceGameS + 60) this.retire(car, `is still queued at ${car.entry_lane} past the give-up time`);
      } else if (["to_exit", "at_exit", "invoiced", "payment_mismatch", "entering", "turned_away", "released"].includes(car.status)) {
        if (quietFor > this.cfg.staleCarGameS) {
          this.retire(car, `has had no events for ${Math.round(quietFor)} game-s (status ${car.status})`,
            car.status === "turned_away" ? "turned_away" : "lost");
        }
      }
    }
    if (overdueParked.length) await this.retireOverdueParked(overdueParked, now);
    for (const gate of gatesToClose) await this.closeGateIfIdle(gate);
    if (this.counters.ghosts_retired > retiredBefore) {
      for (const lane of this.entryLanes.values()) await this.pumpEntry(lane); // spots/lanes freed
    }
  }

  /**
   * A parked car looks long overdue: its leaving event was lost - or our clock is wrong. Ask
   * the simulator which spots are really occupied (one list call, at most every
   * parkedCheckGameS) and only let go of cars whose spot is empty. Writing off a car that is
   * still there frees its spot for a second car and a fine (04:16: 27 at once).
   */
  private async retireOverdueParked(cars: Car[], now: number) {
    if (now - this.lastParkedCheckG < this.cfg.parkedCheckGameS) return;
    this.lastParkedCheckG = now;
    let occupied: Map<string, number>;
    try {
      occupied = new Map((await this.sim.listParkingSpots()).map((s) => [s.name, Number(s.detectedCars) || 0]));
    } catch (err) {
      this.note("warn", `cannot check overdue parked cars: ${(err as Error).message}`);
      return;
    }
    for (const car of cars) {
      if (!this.cars.has(car.plate) || car.status !== "parked") continue;
      if (car.spot && (occupied.get(car.spot) ?? 0) > 0) {
        car.parkedG = now; // still there: check again after another full allowance
        continue;
      }
      this.retire(car, `is still recorded in ${car.spot} well past its planned ${car.planned_minutes}m, and the spot is empty`);
    }
  }

  private finish(car: Car, e: EventRecord) {
    car.left_at = e.ServerDateTime ?? null;
    if (!["neglected", "turned_away", "lost"].includes(car.status)) car.status = "gone";
    if (car.payment_ok) this.recentPaid.set(car.plate, this.clock.now());
    const session: SessionView = { ...publicCar(car), parked_seconds: simSecondsBetween(car.parked_at, car.left_spot_at) };
    this.completed.push(session);
    if (this.completed.length > this.cfg.completedSessionsSize) this.completed.shift();
    if (!this.replaying) this.store.recordSession(session); // already stored the first time round
    this.cars.delete(car.plate);
  }

  async cmd(what: string, fn: () => Promise<void>, args: (string | number)[], actor: string | null = null): Promise<boolean> {
    if (this.replaying) return true; // the command was sent the first time round
    const t0 = performance.now();
    let ok = true, error: string | null = null;
    try {
      await fn();
    } catch (ex) {
      ok = false;
      error = (ex as Error).message ?? String(ex);
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

  // ---------------------------------------------------------------------------
  // manual control from the dashboard - always run through exclusive()
  // ---------------------------------------------------------------------------
  /** Reconcile a car that was parked without the normal entry/spot telemetry. */
  async manualReconcileCar(plate: string, minutes: number, actor: string): Promise<ControlResult> {
    const car = this.cars.get(plate);
    if (!car || car.status !== "unknown" || !car.exit_lane) return fail(`no unreconciled manual car ${plate} is waiting at an exit`);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return fail("minutes must be an integer between 1 and 1440");
    car.planned_minutes = minutes;
    car.charge_override = parkingCost(minutes * 60, minutes, car.car_type, this.cfg);
    car.billing_basis = `operator reconciled duration ${minutes}m`;
    car.unknown_reason = null;
    car.status = "at_exit";
    if (car.manualIncidentId !== null) {
      this.store.resolveIncident(car.manualIncidentId, actor, `reconciled ${minutes} minute manual parking`, "resolved");
    }
    this.note("warn", `${actor} reconciled manually parked ${plate} as ${minutes} minutes; charging before release`);
    this.scheduleCharge(plate, this.chargeDelay(car.exit_lane));
    return ok(`${plate} reconciled; invoice will be requested at the exit`);
  }

  /** Run fn in turn with webhooks and ticks, so it never sees half-updated state. */
  exclusive<T>(fn: () => Promise<T> | T, label = "manual command"): Promise<T> {
    return this.queue.run(fn, label);
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

  /**
   * Put a parking spot into, or take it out of, OUR maintenance mode (sensorHealth.ts).
   * Nothing is sent to the simulator - it has no maintenance command for a spot - so this
   * only changes whether cars are offered it. Different from manualSpotRepair(), which
   * asks the simulator to repair a spot it reports broken.
   */
  async setSpotService(name: string, inService: boolean, actor: string, reason = ""): Promise<ControlResult> {
    const sensors = this.subsystems.find((s) => s.name === "spot_sensors") as SpotSensors | undefined;
    if (!sensors) return fail("spot sensor monitoring is not running");
    const result = sensors.setService(name, inService, actor, reason);
    if (result.ok && inService) await this.resume(); // a spot came back: cars may be waiting
    return result;
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

  /**
   * Fans can be repaired through the simulator API; lights cannot.
   *
   * Verified against the running simulator on 2026-09-20: POST /lights/{name}/repair,
   * /lights/group/{group}/repair and /lights/{name}/fix all answer 404, while
   * /exhaust-fans/{name}/repair answers 201. The documented endpoint list says the same.
   * So the only thing an operator can do about a broken light is put it on record - which
   * is worth doing properly rather than refusing, because nothing else will chase it.
   */
  async manualComponentRepair(kind: "fan" | "light", name: string, actor: string): Promise<ControlResult> {
    const part = this.components.get(kind, name);
    if (!part) return fail(`unknown ${kind} ${name}`);
    if (kind === "light") return this.reportLightFault(part, actor);
    if (part.maintenance) return fail(`${name} is already under maintenance`);
    if (part.on) return fail(`${name} is operating - wait for it to be idle`);
    if (!(await this.cmd("repair", () => this.sim.repairFan(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
    this.components.repairStarted(kind, name, actor, !part.broken);
    return ok(`maintenance started on ${name}`);
  }

  /**
   * Manual control of a part a subsystem owns - the environment's exhaust fans and lights.
   * Each subsystem is offered the command and returns null for anything that is not its
   * own, so a new subsystem can add controls without this method knowing about it.
   */
  async manualDevice(kind: ComponentKind, name: string, action: string, actor: string): Promise<ControlResult> {
    for (const s of this.subsystems) {
      const result = await s.control?.(kind, name, action, actor);
      if (result) return result;
    }
    return fail(`nothing can ${action} ${kind} ${name}`);
  }

  /**
   * A broken light cannot be repaired through the API, so record it as an incident that an
   * operator has to close by hand. One open incident per light: pressing the button again
   * points at the one already raised rather than filling the page with duplicates.
   */
  private reportLightFault(part: { name: string; zone: string }, actor: string): ControlResult {
    const open = this.store.listIncidents({ status: "open", limit: 1000 })
      .find((i) => i.kind === "light_fault" && i.component === part.name);
    if (open) return ok(`${part.name} is already reported - incident #${open.id}`);

    const incident = this.store.createIncident({
      status: "open",
      kind: "light_fault",
      zone: part.zone || null,
      component: part.name,
      reason: `${part.name} reported faulty by ${actor}; the simulator has no light repair endpoint`,
      confidence: "high",
      evidence: { reported_by: actor, health: this.components.health(this.components.get("light", part.name)!) },
    });
    this.store.recordAudit({ actor, action: "light.fault_reported", target: part.name, ok: true });
    this.note("warn", `${actor} reported light ${part.name} faulty - incident #${incident.id}`);
    return ok(`${part.name} cannot be repaired through the simulator - raised incident #${incident.id}`);
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
    const environment = this.subsystems.find((s) => s.name === "environment")?.snapshot?.() as StateSnapshot["environment"];
    const spots = [...this.spots.values()]
      .sort((a, b) => a.purpose.localeCompare(b.purpose) || spotNumber(a.name) - spotNumber(b.name))
      .map((s) => ({
        name: s.name, zone: s.zone, purpose: s.purpose, car_type: s.car_type, broken: s.broken,
        maintenance: s.maintenance, occupant: s.occupant, occupants: [...s.occupants], reserved_for: s.reserved_for, detected: s.detected,
        available: s.available, out_of_service: s.out_of_service,
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
      exit_lanes: [...this.exitLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, releasing: [...l.releasing].sort() })),
      active_cars: [...this.cars.values()].map(publicCar),
      recent_sessions: this.completed.slice(-50),
      counters: { ...this.counters },
      feed: this.feed.slice(-100),
      components: this.components.views(),
      subsystems: Object.fromEntries(this.subsystems.filter((s) => s !== this.components && s.snapshot)
        .map((s) => [s.name, s.snapshot!()])),
      environment,
      queue: this.queue.stats?.() ?? null,
    };
  }
}
