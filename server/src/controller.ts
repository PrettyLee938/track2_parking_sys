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
  type CarStatus, type CarView, type ComponentWearView, type ControlResult, type Counters, type DeviceAction, type DeviceView,
  type FeedItem, type FeedLevel, type GateAction,
  type GateHold, type SessionView, type SimParkingSpot, type StateSnapshot, type TimeScaleSource, type TimeseriesPoint,
  normaliseZone,
  type SimZone, type ZoneAirView, type ZoneSummary,
} from "@gpa/shared";
import { getAllocator, spotNumber, type Allocator, type AllocSpot } from "./allocation";
import {
  AirQuality, Device, WearBook, ageSinceService, devicesFrom, isDaytime, wearRatio, wearSinceRepair,
  type ComponentKind, type WearThresholds,
} from "./components";
import { chargingCost, parkingCost } from "./billing";
import { readSimGameSpeed, validateTunables, type Settings } from "./config";
import { GameClock } from "./gameClock";
import { SerialQueue, type TaskQueue } from "./serialQueue";
import type { SimApi } from "./simClient";
import type { ActionRecord, EventRecord, Store } from "./store";
import { matches, resolve as resolveTopology, type Topology } from "./topology";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const nowS = () => Date.now() / 1000;

/** Real seconds between writes of the wear book (it changes on almost every event). */
const WEAR_SAVE_INTERVAL_S = 15;

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

/** Lights and fans are keyed by kind too: a light and a fan may share a name. */
const deviceKey = (kind: "light" | "fan", name: string) => `${kind}:${name}`;

/** The simulator's ComponentType strings mapped to our four kinds. */
function componentKind(simType: string | undefined): ComponentKind | null {
  switch (simType) {
    case ComponentType.BarrierGate: return "gate";
    case ComponentType.ParkingSpot: return "spot";
    case ComponentType.Light: return "light";
    case ComponentType.ExhaustFan: return "fan";
    default: return null;
  }
}

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
  lastEventReal: number | null = null;
  private tickHandle: NodeJS.Timeout | null = null;
  private tickPending = false;
  private stopped = false;

  topology: Topology | null = null;
  spots = new Map<string, Spot>();
  gates = new Map<string, Gate>();
  /** Lights and exhaust fans, keyed "light:NAME" / "fan:NAME" (names may collide). */
  devices = new Map<string, Device>();
  /** Usage cycles for every component kind; loaded from the database at startup. */
  readonly wear = new WearBook();
  readonly air: AirQuality;
  /** Daytime in the simulator, from the last ServerDateTime seen. Null until one arrives. */
  daytime: boolean | null = null;
  /** The last ServerDateTime the simulator stamped, so a retuned window can re-read it. */
  private lastSimStamp: string | null = null;
  private lastMaintSweep = 0;   // game clock
  private lastWearSave = 0;     // real seconds
  /** Device key -> game time it was switched on, for accruing runtime. */
  private readonly deviceOnSince = new Map<string, number>();
  /** "kind:name" of components we put under preventive maintenance, until reported fixed. */
  private readonly servicing = new Set<string>();
  /** "kind:name" -> game time we last sent a repair, so a dropped one is re-sent. */
  private readonly repairSentG = new Map<string, number>();
  /**
   * Game time of the last zone poll. Starts at -Infinity so the very first tick polls
   * rather than waiting out an interval: the game clock also starts near zero, so a plain
   * 0 here means "just polled" and the first reading is delayed by a whole interval - or,
   * on a clock that has not advanced, never taken at all.
   */
  private lastZonePollG = Number.NEGATIVE_INFINITY;
  /** carbon_monoxide_event webhooks handled - distinct from how many zones have a reading. */
  private coEvents = 0;
  private zonePolls = 0;
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
    breakdowns: 0, preventive_repairs: 0, reactive_repairs: 0, ventilation_changes: 0, light_changes: 0,
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
    this.air = new AirQuality(() => ({
      onPpm: this.cfg.coOnPpm, offPpm: this.cfg.coOffPpm, trustDangerWord: this.cfg.coTrustDangerWord,
    }));
    // Settings an admin tuned from the dashboard during an earlier run override the
    // environment, or a value someone set mid-run would silently revert on restart.
    const stored = this.store.loadRuntimeSettings();
    if (Object.keys(stored).length) {
      const checked = validateTunables(stored);
      if (checked.ok) Object.assign(this.cfg, checked.values);
      else this.log.warn(`ignoring stored settings: ${checked.errors.join("; ")}`);
    }
    // Wear is cumulative across restarts: a component half-way to its service interval
    // must still be half-way there after a crash mid-run.
    this.wear.load(this.store.loadWear());
  }

  /**
   * Wear mutations, skipped while replaying.
   *
   * On restart the wear book is loaded from the database *and* recent events are replayed
   * through the handlers. Counting again during replay would double every cycle - a gate
   * on 5 came back on 10. The book already holds everything up to the last save, so replay
   * must not touch it. The cost is up to WEAR_SAVE_INTERVAL_S of wear lost in a crash,
   * which only ever delays a service slightly; over-counting would trigger repairs that
   * were never earned.
   */
  private countWear(kind: ComponentKind, name: string, zone = ""): void {
    if (!this.replaying) this.wear.countCycle(kind, name, zone);
  }

  private noteBreakdown(kind: ComponentKind, name: string, at: string, zone = ""): void {
    if (!this.replaying) this.wear.markBroken(kind, name, at, zone);
  }

  private noteRepair(kind: ComponentKind, name: string, at: string, zone = ""): void {
    if (!this.replaying) this.wear.markRepaired(kind, name, at, zone);
  }

  /** Service intervals preventive maintenance measures against. */
  private get wearThresholds(): WearThresholds {
    return {
      gateCycles: this.cfg.maintGateCycles,
      spotCycles: this.cfg.maintSpotCycles,
      deviceRuntimeGameS: this.cfg.maintDeviceRuntimeGameS,
      deviceCycles: this.cfg.maintDeviceCycles,
      maxAgeS: this.cfg.maintMaxAgeS,
    };
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
    await this.syncDevices();
    await this.reconcile(freshLayout);
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
    // A sync takes the simulator's word for every device's state, and the lighting and
    // ventilation loops only fire on a *transition* - so without this, a fan the simulator
    // reports as off stays off until the next CO reading crosses a threshold, and lights
    // are never re-asserted after a restart (replay sets daytime but suppresses the action).
    await this.applyLighting();
    await this.applyVentilation();
  }

  /** The simulator reads settings.json when it starts: a new value there means it was
   * restarted at another speed, so stays learned at the old speed no longer apply. */
  private refreshSimSettingsSpeed() {
    const speed = readSimGameSpeed(this.cfg.simSettingsFile);
    if (this.clock.setSettingsSpeed(speed)) this.note("info", `simulator settings.json game speed is now ${speed}; relearning`);
  }

  /**
   * Discovers the lights and exhaust fans (Level 2; Level 1 has neither). Like the other
   * list-* calls this is costly, so it runs only with a sync. A level without these
   * endpoints simply has no devices and the ventilation and lighting loops stay idle.
   */
  private async syncDevices() {
    const kinds: Array<["light" | "fan", (() => Promise<unknown[]>) | undefined]> = [
      ["light", this.sim.listLights?.bind(this.sim)],
      ["fan", this.sim.listExhaustFans?.bind(this.sim)],
    ];
    for (const [kind, list] of kinds) {
      if (!list) continue;
      let rows: unknown;
      try {
        rows = await list();
      } catch (ex) {
        this.note("warn", `could not list ${kind}s: ${(ex as Error).message.slice(0, 120)}`);
        continue;
      }
      for (const fresh of devicesFrom(kind, rows)) {
        const key = deviceKey(kind, fresh.name);
        const existing = this.devices.get(key);
        if (existing) {
          // Live state wins, but keep what we know that the list does not report.
          existing.on = fresh.on;
          existing.broken = fresh.broken;
          existing.maintenance = fresh.maintenance;
          existing.zone = fresh.zone || existing.zone;
          existing.pending = null;
        } else {
          this.devices.set(key, fresh);
        }
        this.wear.get(kind, fresh.name, fresh.zone);
      }
    }
    const lights = [...this.devices.values()].filter((d) => d.kind === "light").length;
    const fans = this.devices.size - lights;
    if (lights || fans) this.note("info", `components: ${lights} light(s), ${fans} exhaust fan(s)`);
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
    // A different level has different components. Bank any running device time first, so
    // the wear already earned is kept even though these names are about to disappear.
    for (const dev of this.devices.values()) this.bankRuntime(dev);
    this.store.saveWear(this.wear.all());
    this.devices = new Map();
    this.deviceOnSince.clear();
    this.servicing.clear();
    this.repairSentG.clear();
    this.lastZonePollG = Number.NEGATIVE_INFINITY;
    this.coEvents = 0;
    this.daytime = null;
    this.lastSimStamp = null;
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
      else if (car.status === "at_exit") this.scheduleCharge(car.plate, this.cfg.exitChargeDelayGameS);
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

    // The only clock that reports the simulator's own time of day.
    const stamp = str(e, "ServerDateTime");
    if (stamp) this.lastSimStamp = stamp;
    await this.recomputeDaytime();

    switch (e.EventClass) {
      case EventClass.CarSpotAction: await this.routeCarEvent(e); break;
      case EventClass.GateAction: await this.onGate(e); break;
      case EventClass.PaymentMade: await this.onPayment(e); break;
      case EventClass.ComponentBroken: await this.onComponent(e, true); break;
      case EventClass.ComponentFixed: await this.onComponent(e, false); break;
      case EventClass.Penalty: await this.onPenalty(e); break;
      case EventClass.CarbonMonoxide: await this.onCarbonMonoxide(e); break;
    }
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
    const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
    if (lane.gate && (!gate || !gate.operable)) return; // held; onComponent() pumps again once fixed
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
    this.countWear("spot", name, spot.zone); // one use of this spot
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
    this.scheduleCharge(plate, this.cfg.exitChargeDelayGameS);
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
      basis = "amount stated by simulator";
    } else {
      if (gameS === null && !car.planned_minutes) this.note("warn", `${plate}: no parking times and no planned duration, billing 1 minute`);
      parking = parkingCost(gameS ?? 60, car.planned_minutes, car.car_type, this.cfg);
      basis = `planned ${car.planned_minutes}m, measured ${gameS !== null ? (gameS / 60).toFixed(2) : "?"} game-min`;
    }
    const electric = chargingCost(car.car_type, this.cfg);
    if (await this.cmd("charge", () => this.sim.carCharge(plate, parking, electric), [plate, parking, electric])) {
      car.charge_parking = parking;
      car.charge_electric = electric;
      car.status = "invoiced";
      this.note("info", `${plate} invoiced ${(parking + electric).toFixed(2)} (${basis})`);
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
      this.note("warn", `payment ${amount.toFixed(2)} from ${plate} with no invoice - ignored`);
      return;
    }
    const expected = car.charge_parking + (car.charge_electric ?? 0);
    car.paid = amount;
    if (Math.abs(amount - expected) <= this.cfg.paymentTolerance) {
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

  async release(car: Car): Promise<void> {
    if (this.replaying) return; // whether it was released is in the recorded commands
    if (car.status !== "released") {
      car.status = "released";
      car.releasedG = this.clock.now();
      car.gotoResends = 0;
    }
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    lane?.releasing.add(car.plate);
    const gate = lane?.gate ? this.gates.get(lane.gate) : undefined;
    const leave = () => this.leavePark(car);
    if (lane?.gate && (!gate || !gate.operable)) {
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
    // One cycle = one confirmed open. Counting the close too would double every gate's
    // wear for the same single use.
    if (gate.state === GateState.Open && was !== GateState.Open) this.countWear("gate", gate.name, gate.zone);

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

  /** Cars are waiting on this gate or crossing it: do not close it. */
  gateBusy(name: string): boolean {
    return [...this.entryLanes.values()].some((l) => l.gate === name && (l.current || l.queue.length)) ||
      [...this.exitLanes.values()].some((l) => l.gate === name && l.releasing.size > 0);
  }

  /**
   * A car is actually crossing this gate right now - the only thing that should block a
   * repair. A *queue* waiting at a gate is not "in use": the spec's in-use repair penalty
   * is Penalty_RepairAnOccupiedSpot, about a car sitting in a parking spot. Treating a
   * queue as in-use deadlocked a broken entry gate: cars pile up behind it, the queue
   * never empties because the gate is broken, and the repair that would fix it is refused
   * forever while the cars are fined for being neglected.
   */
  gatePassing(name: string): boolean {
    return [...this.entryLanes.values()].some((l) => l.gate === name && l.current !== null) ||
      [...this.exitLanes.values()].some((l) => l.gate === name && l.releasing.size > 0);
  }

  async closeGateIfIdle(name: string | null): Promise<void> {
    const gate = name ? this.gates.get(name) : undefined;
    if (gate && gate.operable && gate.hold !== "open" && !this.gateBusy(gate.name) && !gate.onOpen.length &&
        (gate.state === GateState.Open || gate.state === GateState.Opening)) {
      await this.requestClose(gate);
    }
  }

  /**
   * component_broken / component_fixed for any of the four kinds. Lights and exhaust
   * fans used to fall through to the spot map, miss, and be logged but never tracked -
   * so a broken fan stayed invisible and the zone it serves went unventilated.
   */
  private async onComponent(e: EventRecord, broken: boolean) {
    const name = str(e, "Name") ?? "", simKind = str(e, "Type");
    const kind = componentKind(simKind);
    const target = kind === "gate" ? this.gates.get(name)
      : kind === "spot" ? this.spots.get(name)
      : kind ? this.devices.get(deviceKey(kind, name))
      : undefined;

    if (target) {
      target.broken = broken;
      if (!broken) target.maintenance = false;
    } else if (kind === "light" || kind === "fan") {
      // First sight of a device the list-* call never returned: record it anyway, so a
      // level whose endpoints we cannot read still shows its broken components.
      const dev = new Device(kind, name, "");
      dev.broken = broken;
      this.devices.set(deviceKey(kind, name), dev);
    }

    if (kind) {
      const zone = (target as { zone?: string } | undefined)?.zone ?? "";
      if (broken) this.noteBreakdown(kind, name, e._received_at, zone);
      else this.noteRepair(kind, name, e._received_at, zone);
      // Our maintenance on it is over either way: it frees a slot in the zone's budget.
      this.servicing.delete(`${kind}:${name}`);
      if (!broken) this.repairSentG.delete(`${kind}:${name}`);
    }
    if (broken) this.counters.breakdowns++;

    this.note(broken ? "error" : "info", `${simKind} ${name} ${broken ? "BROKEN" : "fixed"}`);
    if (!broken) for (const lane of this.entryLanes.values()) await this.pumpEntry(lane);
    // Either way the zone's ventilation may need to move: a fan that came back may be
    // needed now, and one that just broke may have a sibling that can take over.
    if (kind === "fan") await this.applyVentilation();
  }

  /**
   * carbon_monoxide_event: record the reading and, when the zone crosses a threshold,
   * switch that zone's exhaust fans. Hysteresis lives in AirQuality - acting on every
   * reading would flap the fans and burn the usage cycles we are asked to conserve.
   */
  private async onCarbonMonoxide(e: EventRecord) {
    const zone = str(e, "ZoneName") ?? "";
    if (!zone) return;
    this.coEvents++;
    const changed = this.recordAir(zone, Number(e.CarbonMonoxideLevel) || 0, str(e, "DangerLevel") ?? "",
      e._received_at, "webhook");
    // The tick re-asserts ventilation anyway; acting here too means a webhook is answered
    // at once rather than up to a tick later.
    if (changed) await this.applyVentilation();
  }

  /**
   * Records one zone's CO reading and logs a threshold crossing. Shared by the two
   * sources - the webhook and the poll - which otherwise carried the same five lines
   * twice, and would drift apart the first time the message changed.
   */
  private recordAir(zone: string, level: number, danger: string, at: string, source: "webhook" | "polled"): boolean {
    const { air, changed } = this.air.update(zone, level, danger, at);
    if (!changed) return false;
    this.note(air.ventilating ? "warn" : "info",
      `CO ${zone} ${level}${danger ? ` (${danger})` : ""} - ventilation ${air.ventilating ? "ON" : "OFF"}` +
      `${source === "polled" ? " (polled)" : ""}`);
    return true;
  }

  /**
   * Reads CO straight from the simulator instead of waiting to be told.
   *
   * carbon_monoxide_event is only sent at Mid and above (~50), so a webhook-only system
   * cannot see a zone at 5, 20 or 40 - and therefore cannot act on any threshold below
   * Mid, however it is configured. This poll makes lower thresholds mean something, and
   * doubles as a safety net if a CO webhook is lost. Off unless zonePollGameS is set,
   * because every list-* call carries a simulated operational cost.
   */
  private async pollZoneAir(now: number) {
    if (this.replaying || !this.synced || !this.cfg.zonePollGameS) return;
    if (!this.sim.listZones) return;
    if (now - this.lastZonePollG < this.cfg.zonePollGameS) return;
    this.lastZonePollG = now;

    let rows: unknown;
    try {
      rows = await this.sim.listZones();
    } catch (ex) {
      this.note("warn", `could not list zones: ${(ex as Error).message.slice(0, 120)}`);
      return;
    }
    if (!Array.isArray(rows)) return;

    const at = new Date().toISOString();
    for (const raw of rows as SimZone[]) {
      const z = normaliseZone(raw ?? {});
      if (z) this.recordAir(z.name, z.level, z.danger, at, "polled");
    }
    this.zonePolls++;
    // No applyVentilation here: tick() calls it on the line after this one.
  }

  /** Brings every fan in line with what its zone's air currently needs. */
  private async applyVentilation() {
    if (this.replaying) return;
    for (const dev of this.devices.values()) {
      if (dev.kind !== "fan") continue;
      const want = this.wantsVentilation(dev);

      // Safety override. An operator may keep a fan *running* for as long as they like -
      // that only costs usage cycles. Keeping one *off* while its zone is actually
      // polluted is Penalty_ZonePollutedWithHighCO, and an operator who switches a fan off
      // and forgets would otherwise cause it for the rest of the run: nothing reconsiders
      // a hold. Ventilation is a safety function, so the hold loses.
      if (dev.hold === "off" && want) {
        dev.hold = null;
        this.note("error",
          `${dev.name}: releasing the operator hold - ${dev.zone || "the park"} needs ventilation`);
      }

      if (!dev.automatic) continue;
      if (await this.setDevice(dev, want)) {
        this.counters.ventilation_changes++;
        // Name the fan and the reading that moved it. The transition note above only says
        // a *zone* changed; without this there is no record that a specific fan was
        // actually commanded, which is the thing you want to see when checking it works.
        const air = dev.zone ? this.air.get(dev.zone) : this.air.all().find((z) => z.ventilating);
        const reading = air ? `${air.zone} CO ${air.level}` : "no reading";
        const limit = want ? this.cfg.coOnPpm : this.cfg.coOffPpm;
        this.note(want ? "warn" : "info",
          `fan ${dev.name} ${want ? "ON" : "OFF"} - ${reading} vs threshold ${limit}`);
      }
    }
  }

  /**
   * Whether this fan should be running.
   *
   * A fan with no zone serves the whole park, so it follows *any* zone that needs
   * ventilation. The simulator really does report zoneless components - its own
   * list-exhaust-fans example is `"name": "fan0", "zoneParent": ""` - and skipping those
   * meant a fan that could never be switched on however high CO went.
   */
  private wantsVentilation(dev: Device): boolean {
    return dev.zone ? (this.air.get(dev.zone)?.ventilating ?? false) : this.air.anyVentilating;
  }

  /**
   * Why a fan is in the state it is, in one line. Ventilation has several independent
   * reasons not to act (broken, held, no reading for its zone, no such endpoint), and
   * without this the dashboard can only show "off" and leave you guessing which.
   */
  private ventilationReason(dev: Device): string {
    const blocked = this.deviceBlocker(dev);
    if (blocked) return blocked;
    const want = this.wantsVentilation(dev);
    if (want) {
      const where = dev.zone ? `${dev.zone} is` : "the park has a zone"; // a zoneless fan serves everywhere
      return dev.on ? `extracting: ${where} above the CO threshold` : "should be on - command pending";
    }
    if (!dev.zone) {
      return this.air.all().length ? "idle: no zone is above the CO threshold" : "idle: no CO readings yet";
    }
    const air = this.air.get(dev.zone);
    if (!air) return `idle: no CO reading for ${dev.zone} yet`;
    return `idle: ${dev.zone} is at ${air.level}, below the ${this.cfg.coOnPpm} threshold`;
  }

  /**
   * Switches a light or fan, counting the cycle and its on-time. Returns true when a
   * command was actually sent. Never touches a broken or under-maintenance device:
   * operating one is a penalty.
   */
  private async setDevice(dev: Device, on: boolean, actor: string | null = null): Promise<boolean> {
    if (this.replaying || dev.on === on || dev.pending === (on ? "on" : "off") || !dev.operable) return false;
    const call = dev.kind === "light"
      ? (on ? this.sim.lightOn : this.sim.lightOff)
      : (on ? this.sim.fanOn : this.sim.fanOff);
    if (!call) return false; // this level has no such endpoint

    dev.pending = on ? "on" : "off";
    const what = `${dev.kind}-${on ? "on" : "off"}`;
    const sent = await this.cmd(what, () => call.call(this.sim, dev.name), [dev.name], actor);
    dev.pending = null;
    if (!sent) return false;

    // On-time accrues in game seconds; bank it when the device goes off.
    if (on) {
      this.deviceOnSince.set(deviceKey(dev.kind, dev.name), this.clock.now());
    } else {
      this.bankRuntime(dev);
    }
    dev.on = on;
    this.countWear(dev.kind, dev.name, dev.zone);
    return true;
  }

  /** Adds the time a device has been running to its wear, and restarts the meter. */
  private bankRuntime(dev: Device) {
    const key = deviceKey(dev.kind, dev.name);
    const since = this.deviceOnSince.get(key);
    if (since === undefined) return;
    this.wear.addRuntime(dev.kind, dev.name, Math.max(0, this.clock.now() - since), dev.zone);
    this.deviceOnSince.delete(key);
  }

  /**
   * Works out whether it is day in the simulator and switches the lights if that changed.
   * Called both when an event brings a new stamp and when the daylight window itself is
   * retuned - moving the window has to re-evaluate the *last* stamp, or the lights would
   * stay wrong until the next event happened to arrive.
   */
  private async recomputeDaytime(): Promise<void> {
    const day = isDaytime(this.lastSimStamp, this.cfg.daylightFromHour, this.cfg.daylightToHour);
    if (day === null || day === this.daytime) return;
    const first = this.daytime === null;
    this.daytime = day;
    if (!first) this.note("info", `simulator is now ${day ? "day" : "night"}`);
    await this.applyLighting();
  }

  /**
   * Walks the whole ventilation chain and reports where it stops, for GET
   * /debug/ventilation. A fan that will not switch on can be blocked at any of half a
   * dozen independent points - no fans discovered, none accepted by the intake, the
   * controller in passive mode, a zone name that does not match, the fan broken or held -
   * and each of those looks identical from outside: a fan that is simply off.
   */
  ventilationDiagnosis() {
    const fans = [...this.devices.values()].filter((d) => d.kind === "fan");
    return {
      synced: this.synced,
      controller_enabled: this.cfg.controllerEnabled,
      replaying: this.replaying,
      thresholds: { on_ppm: this.cfg.coOnPpm, off_ppm: this.cfg.coOffPpm, trust_danger_word: this.cfg.coTrustDangerWord },
      endpoint_available: !!this.sim.fanOn,
      fans_discovered: fans.length,
      co_events_seen: this.coEvents,
      zones_reporting: this.air.all().length,
      zone_poll: this.cfg.zonePollGameS
        ? { every_game_s: this.cfg.zonePollGameS, polls: this.zonePolls, available: !!this.sim.listZones }
        : { every_game_s: 0, note: "off - the simulator only sends carbon_monoxide_event at Mid (~50) and above, so a threshold below Mid cannot fire without this" },
      zones_with_readings: this.air.all().map((z) => ({ zone: z.zone, level: z.level, danger: z.danger, ventilating: z.ventilating, at: z.at })),
      zones_wanting_ventilation: this.air.ventilating(),
      fans: fans.map((d) => ({
        name: d.name,
        zone: d.zone,
        zone_note: d.zone ? "matched against the zone of each CO reading" : "no zone: follows any zone that needs ventilation",
        on: d.on,
        broken: d.broken,
        maintenance: d.maintenance,
        hold: d.hold,
        should_be_on: this.wantsVentilation(d),
        blocked_by: this.deviceBlocker(d),
        reason: this.ventilationReason(d),
      })),
      hint: fans.length === 0
        ? "No exhaust fans were discovered. Check GET /api/v1/list-exhaust-fans on the simulator: the response must be an array whose items carry a name."
        : this.air.all().length === 0
        ? "No CO reading from either source. Webhooks only arrive at Mid (~50) and above; if zone_poll is off, turn it on to read the level directly. Also check /debug/stats for dropped events and that GPA_CONTROLLER_ENABLED is true."
        : null,
    };
  }

  /**
   * The single condition stopping this device being switched, or null if nothing is.
   * Shared by fans and lights: the four reasons a device cannot be operated at all -
   * broken, under maintenance, no endpoint, held by an operator - are the same whichever
   * rule drives it, and were written out twice before.
   */
  private deviceBlocker(dev: Device): string | null {
    if (!this.cfg.controllerEnabled) return "the controller is in passive mode (GPA_CONTROLLER_ENABLED=false)";
    if (!this.synced) return "not synced with the simulator yet";
    const light = dev.kind === "light";
    if (!(light ? this.sim.lightOn : this.sim.fanOn)) return `this level has no ${light ? "light" : "exhaust fan"} endpoint`;
    if (dev.broken) return "broken - operating it would be a penalty";
    if (dev.maintenance) return "under maintenance";
    if (dev.hold) return `held ${dev.hold} by an operator - Automatic returns it to ${light ? "daylight" : "CO"} control`;
    return null;
  }

  /** The same one-line explanation as ventilationReason, for a light. */
  private lightingReason(dev: Device): string {
    const blocked = this.deviceBlocker(dev);
    if (blocked) return blocked;
    if (!this.cfg.lightsFollowDaylight) return "daylight control is off - manual only";
    if (this.daytime === null) return "waiting for the first event that carries a simulator timestamp";
    const window = `${this.cfg.daylightFromHour}:00-${this.cfg.daylightToHour}:00`;
    return this.daytime
      ? `off: daytime in the simulator (daylight ${window})`
      : `on: night in the simulator (daylight ${window})`;
  }

  /**
   * "Lights should not work at day time of simulator." The in-world hour is read off the
   * ServerDateTime the simulator stamps on events (no endpoint is known to report it),
   * so this only acts once an event has been seen.
   */
  private async applyLighting() {
    if (this.replaying || !this.cfg.lightsFollowDaylight || this.daytime === null) return;
    const wantOn = !this.daytime;
    for (const dev of this.devices.values()) {
      if (dev.kind !== "light" || !dev.automatic) continue;
      if (await this.setDevice(dev, wantOn)) {
        this.counters.light_changes++;
        this.note("info", `light ${dev.name} ${wantOn ? "ON" : "OFF"} - simulator is ${wantOn ? "at night" : "in daylight"}`);
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
    await this.checkStuckGotos(now);
    await this.sweepGhosts(now);
    await this.repairBroken(now);
    await this.sweepMaintenance(now);
    await this.pollZoneAir(now);
    // Ventilation and lighting are re-asserted every tick, not only when a reading
    // crosses a threshold. A transition gives a fan exactly one chance to be switched,
    // and anything that blocked that one attempt - the fan momentarily under maintenance,
    // a dropped command, a sync still in flight - left it wrong until the *next* crossing,
    // which may never come: with a low stop threshold a busy zone simply stays above it
    // and never transitions again. These are cheap: setDevice returns immediately unless
    // a device is actually in the wrong state.
    await this.applyVentilation();
    await this.applyLighting();
    this.sample(nowS());
    this.persistWear();
    const horizon = now - this.cfg.repeatExitWindowGameS;
    for (const [plate, t] of this.recentPaid) if (t < horizon) this.recentPaid.delete(plate);
  }

  /**
   * Reactive repair: fix what the simulator says is broken, as soon as it can be fixed.
   *
   * "Things can break, but the car park shouldn't" - and nothing a broken component serves
   * works until it is repaired. A broken entry gate closes that entrance completely: cars
   * queue behind it and are eventually fined for being neglected. So this ignores the
   * per-zone maintenance budget (that capacity is already lost) and only respects the one
   * rule the spec actually states - Penalty_RepairAnOccupiedSpot.
   *
   * Repair commands can be dropped like any other, which would leave a component broken
   * for the rest of the run, so each is re-sent every repairRetryGameS while it is still
   * reported broken.
   */
  private async repairBroken(now: number) {
    if (this.replaying || !this.synced || !this.cfg.autoRepairBroken) return;

    const tryRepair = async (kind: ComponentKind, name: string, send: () => Promise<void>) => {
      const key = `${kind}:${name}`;
      const last = this.repairSentG.get(key);
      if (last !== undefined && now - last < this.cfg.repairRetryGameS) return;
      this.repairSentG.set(key, now);
      if (!(await this.cmd("repair", send, [name]))) return;
      this.counters.reactive_repairs++;
      this.servicing.add(key);
      this.note("warn", `repairing broken ${kind} ${name}${last === undefined ? "" : " (re-sent)"}`);
    };

    for (const gate of this.gates.values()) {
      if (!gate.broken || gate.maintenance) continue;
      await tryRepair("gate", gate.name, () => this.sim.repairGate(gate.name));
    }
    for (const spot of this.spots.values()) {
      if (!spot.broken || spot.maintenance) continue;
      // The one in-use rule the spec states: Penalty_RepairAnOccupiedSpot.
      if (spot.occupants.size || spot.reserved_for) continue;
      await tryRepair("spot", spot.name, () => this.sim.repairSpot(spot.name));
    }
    for (const dev of this.devices.values()) {
      if (dev.kind !== "fan" || !dev.broken || dev.maintenance) continue;
      const repair = this.sim.repairFan?.bind(this.sim);
      if (!repair) continue; // only fans are repairable; a broken light can only be reported
      await tryRepair("fan", dev.name, () => repair(dev.name));
    }
  }

  /**
   * Preventive maintenance: repair what is worn *before* it breaks, and only while it is
   * idle. Repairing a gate a car is passing, or an occupied spot, is itself a penalty -
   * the same guards the manual controls use apply here.
   *
   * At most maintMaxConcurrentPerZone components are out of service in a zone at once, so
   * a maintenance sweep never costs a zone its capacity.
   */
  private async sweepMaintenance(now: number) {
    if (this.replaying || !this.cfg.preventiveMaintenance || !this.synced) return;
    if (now - this.lastMaintSweep < this.cfg.maintIntervalGameS) return;
    this.lastMaintSweep = now;

    // The cap counts only the repairs *we* started, not everything out of service.
    // Counting broken components too meant one stuck failure vetoed preventive work in
    // its whole zone indefinitely - which is precisely how the rest of it breaks next.
    // Their capacity is already lost and refusing to service the survivors cannot get it
    // back; what we control is how many components we take out on top of that.
    const busyZones = new Map<string, number>();
    const bump = (zone: string) => busyZones.set(zone, (busyZones.get(zone) ?? 0) + 1);
    for (const key of this.servicing) bump(this.zoneOfComponent(key));

    for (const due of this.wear.due(this.wearThresholds)) {
      const zone = due.zone || "-";
      if ((busyZones.get(zone) ?? 0) >= this.cfg.maintMaxConcurrentPerZone) continue;
      if (await this.serviceComponent(due.kind, due.name, due.ratio)) bump(zone);
    }
  }

  /** The zone of a "kind:name" key, for the maintenance budget. */
  private zoneOfComponent(key: string): string {
    const [kind, ...rest] = key.split(":");
    const name = rest.join(":");
    const live = kind === "gate" ? this.gates.get(name)
      : kind === "spot" ? this.spots.get(name)
      : this.devices.get(key);
    return live?.zone || "-";
  }

  /** Sends a preventive repair if that component is idle and repairable right now. */
  private async serviceComponent(kind: ComponentKind, name: string, ratio: number): Promise<boolean> {
    const why = `worn (${Math.round(ratio * 100)}% of service interval)`;
    if (kind === "gate") {
      const gate = this.gates.get(name);
      // A broken gate is the simulator's to fix; maintenance on a busy one is a penalty.
      if (!gate || gate.broken || gate.maintenance || this.gateBusy(name)) return false; // broken: repairBroken handles it
      if (gate.state !== GateState.Closed) return false; // mid-cycle: catch it next sweep
      if (!await this.cmd("repair", () => this.sim.repairGate(name), [name])) return false;
      gate.maintenance = true;
    } else if (kind === "spot") {
      const spot = this.spots.get(name);
      if (!spot || spot.broken || spot.maintenance) return false;
      if (spot.occupants.size || spot.reserved_for) return false; // repairing an occupied spot is a penalty
      if (!await this.cmd("repair", () => this.sim.repairSpot(name), [name])) return false;
      spot.maintenance = true;
    } else {
      const dev = this.devices.get(deviceKey(kind, name));
      if (!dev || dev.broken || dev.maintenance) return false;
      // Only fans are repairable; a worn light is reported but cannot be serviced.
      if (kind !== "fan" || !this.sim.repairFan) return false;
      // Never pull the fan a zone is actively relying on.
      if (this.wantsVentilation(dev)) return false;
      const repair = this.sim.repairFan.bind(this.sim);
      if (!await this.cmd("repair", () => repair(name), [name])) return false;
      dev.maintenance = true;
      if (dev.on) this.bankRuntime(dev);
    }
    this.counters.preventive_repairs++;
    this.servicing.add(`${kind}:${name}`);
    this.wear.markRepaired(kind, name, new Date().toISOString());
    this.note("warn", `preventive maintenance on ${kind} ${name}: ${why}`);
    return true;
  }

  /** Wear is written periodically, not per cycle: one transaction instead of thousands. */
  private persistWear() {
    if (this.replaying) return;
    const now = nowS();
    if (now - this.lastWearSave < WEAR_SAVE_INTERVAL_S) return;
    this.lastWearSave = now;
    // Running devices have on-time that is not banked yet; include it so a crash loses
    // at most one save interval rather than a whole run of accumulated runtime.
    const gameNow = this.clock.now();
    for (const dev of this.devices.values()) {
      const key = deviceKey(dev.kind, dev.name);
      const since = this.deviceOnSince.get(key);
      if (since === undefined) continue;
      this.wear.addRuntime(dev.kind, dev.name, Math.max(0, gameNow - since), dev.zone);
      this.deviceOnSince.set(key, gameNow);
    }
    this.store.saveWear(this.wear.all());
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
    const car = newCar(plate, str(e, "CarType") || CarType.Normal, toInt(e.PlannedParkingDurationInMinutes), "unknown");
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
    for (const car of [...this.cars.values()]) {
      const quietFor = now - (car.lastSeenG ?? car.arrivedG ?? now);
      if (car.status === "released" && car.releasedG !== null && now - car.releasedG > this.cfg.releaseTimeoutGameS) {
        const gate = car.exit_lane ? this.exitLanes.get(car.exit_lane)?.gate : null;
        this.retire(car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
        if (gate) gatesToClose.add(gate);
      } else if (car.status === "parked") {
        const since = car.parkedG ?? car.lastSeenG;
        const allowed = (car.planned_minutes ?? 0) * 60 + this.cfg.parkedOverstayGameS;
        if (since !== null && now - since > allowed) this.retire(car, `is still recorded in ${car.spot} well past its planned ${car.planned_minutes}m`);
      } else if (car.status === "queued") {
        if (now - (car.arrivedG ?? now) > this.cfg.entryPatienceGameS + 60) this.retire(car, `is still queued at ${car.entry_lane} past the give-up time`);
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
        // A broken gate is always repairable: nothing can cross it, so the queue behind it
        // is stuck *because* it is broken, and repairing is the only way out. Only a car
        // crossing a working gate is a reason to wait.
        if (!gate.broken && this.gatePassing(name)) {
          return fail(`${name} has a car crossing right now - try again in a moment`);
        }
        if (!(await this.cmd("repair", () => this.sim.repairGate(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
        gate.maintenance = true;
        this.servicing.add(`gate:${name}`);
        this.note("warn", `${actor} started ${gate.broken ? "repair of broken" : "maintenance on"} ${name}`);
        return ok(`${gate.broken ? "repair" : "maintenance"} started on ${name}`);
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
    this.note("warn", `${actor} started maintenance on ${name}`);
    return ok(`maintenance started on ${name}`);
  }

  /**
   * Manual control of a light or exhaust fan. "auto" hands it back to the CO and daylight
   * loops, which run on the next reading or tick. Refuses anything the spec penalises:
   * operating or repairing a broken or under-maintenance device.
   */
  async manualDevice(kind: "light" | "fan", name: string, action: DeviceAction, actor: string): Promise<ControlResult> {
    const dev = this.devices.get(deviceKey(kind, name));
    if (!dev) return fail(`unknown ${kind} ${name}`);
    const unusable = dev.broken ? "broken" : dev.maintenance ? "under maintenance" : null;

    if (action === "repair") {
      if (kind !== "fan") return fail("only exhaust fans can be repaired");
      if (!this.sim.repairFan) return fail("this level has no exhaust fan repair endpoint");
      if (dev.maintenance) return fail(`${name} is already under maintenance`);
      if (this.wantsVentilation(dev)) {
        return fail(`${dev.zone || "the park"} needs ventilation right now - repairing ${name} would leave it unventilated`);
      }
      const repair = this.sim.repairFan.bind(this.sim);
      if (!(await this.cmd("repair", () => repair(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
      dev.maintenance = true;
      if (dev.on) this.bankRuntime(dev);
      this.wear.markRepaired(kind, name, new Date().toISOString(), dev.zone);
      this.note("warn", `${actor} started maintenance on ${kind} ${name}`);
      return ok(`maintenance started on ${name}`);
    }

    if (action === "auto") {
      dev.hold = null;
      this.note("info", `${actor} returned ${kind} ${name} to automatic`);
      if (kind === "fan") await this.applyVentilation();
      else await this.applyLighting();
      return ok(`${name} back to automatic`);
    }

    if (unusable) return fail(`${name} is ${unusable} - operating it now is a penalty`);
    const on = action === "on";
    // Refuse up front rather than accept and silently override a moment later: switching
    // a fan off while its zone is polluted is Penalty_ZonePollutedWithHighCO.
    if (kind === "fan" && !on && this.wantsVentilation(dev)) {
      const where = dev.zone || "the park";
      return fail(`${where} is above the CO threshold - ${name} must keep extracting`);
    }
    dev.hold = action;
    // setDevice skips a device already in the wanted state, which is the right answer here.
    if (dev.on === on) return ok(`${name} is already ${action}`);
    if (!(await this.setDevice(dev, on, actor))) return fail(`the simulator rejected ${action} ${name}`);
    this.note("warn", `${actor} switched ${kind} ${name} ${action}`);
    return ok(`${name} switched ${action}`);
  }

  /**
   * Apply tuned settings while the run continues, and store them so a restart keeps them.
   * The ventilation and lighting loops run straight away, so a new threshold takes effect
   * now rather than at the next CO reading - which may be minutes away, or never if the
   * zone has gone quiet.
   */
  async updateSettings(patch: Record<string, unknown>, actor: string): Promise<ControlResult> {
    const checked = validateTunables(patch);
    if (!checked.ok) return fail(checked.errors.join("; "));

    const changed: string[] = [];
    for (const [key, value] of Object.entries(checked.values)) {
      const before = (this.cfg as Record<string, unknown>)[key];
      if (before === value) continue;
      (this.cfg as Record<string, unknown>)[key] = value;
      changed.push(`${key} ${before} -> ${value}`);
    }
    if (!changed.length) return ok("no change");

    this.store.saveRuntimeSettings(checked.values as Record<string, unknown>, actor);
    this.store.recordAction({
      at: new Date().toISOString(), cmd: "settings", args: changed, ok: true, error: null, ms: 0, actor,
    });
    this.note("warn", `${actor} changed settings: ${changed.join(", ")}`);

    // Re-evaluate every zone against the new thresholds, so a lowered "ventilate at"
    // starts the fans now instead of waiting for the next reading to cross it.
    for (const air of this.air.all()) this.air.update(air.zone, air.level, air.danger, air.at);
    await this.applyVentilation();
    await this.recomputeDaytime();
    await this.applyLighting();
    return ok(`updated ${changed.length} setting${changed.length === 1 ? "" : "s"}`);
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
      exit_lanes: [...this.exitLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, releasing: [...l.releasing].sort() })),
      active_cars: [...this.cars.values()].map(publicCar),
      recent_sessions: this.completed.slice(-50),
      counters: { ...this.counters },
      feed: this.feed.slice(-100),
      devices: [...this.devices.values()]
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name))
        .map((d): DeviceView => ({
          kind: d.kind, name: d.name, zone: d.zone, on: d.on,
          broken: d.broken, maintenance: d.maintenance, pending: d.pending, hold: d.hold,
          reason: d.kind === "fan" ? this.ventilationReason(d) : this.lightingReason(d),
        })),
      components: this.componentWear(),
      air: this.air.all() as ZoneAirView[],
      daytime: this.daytime,
    };
  }

  /** Usage cycles joined with each component's live broken/maintenance status. */
  private componentWear(): ComponentWearView[] {
    const t = this.wearThresholds;
    return this.wear.all()
      .map((w): ComponentWearView => {
        const since = wearSinceRepair(w);
        const live = w.kind === "gate" ? this.gates.get(w.name)
          : w.kind === "spot" ? this.spots.get(w.name)
          : this.devices.get(deviceKey(w.kind, w.name));
        return {
          kind: w.kind, name: w.name, zone: w.zone,
          cycles: w.cycles, runtime_game_s: Math.round(w.runtime_game_s),
          breakdowns: w.breakdowns, repairs: w.repairs,
          cycles_since_repair: since.cycles,
          runtime_since_repair_game_s: Math.round(since.runtime_game_s),
          ratio: Math.round(wearRatio(w, t) * 1000) / 1000,
          age_s: Math.round(ageSinceService(w)),
          broken: live?.broken ?? false,
          maintenance: live?.maintenance ?? false,
          last_repair_at: w.last_repair_at, last_broken_at: w.last_broken_at,
        };
      })
      .sort((a, b) => b.ratio - a.ratio || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }
}
