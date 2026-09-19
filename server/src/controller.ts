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
  CORRECT_AMOUNT_PATTERN, CarType, ComponentType, Destination, Direction, EventClass, GateState, PenaltyReason,
  SpotPurpose,
  type CarStatus, type CarView, type Counters, type FeedItem, type FeedLevel, type SessionView, type SimParkingSpot,
  type StateSnapshot, type TimeScaleSource, type ZoneSummary,
} from "@gpa/shared";
import { getAllocator, spotNumber, type Allocator, type AllocSpot } from "./allocation";
import { chargingCost, parkingCost } from "./billing";
import { readSimGameSpeed, type Settings } from "./config";
import { SerialQueue, type TaskQueue } from "./serialQueue";
import type { SimApi } from "./simClient";
import type { EventRecord, Store } from "./store";
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

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const str = (e: EventRecord, k: string) => (e[k] as string | undefined) ?? undefined;

// =============================================================================
// state
// =============================================================================
export class Spot implements AllocSpot {
  broken = false;
  maintenance = false;
  occupant: string | null = null;     // plate physically in the spot ("?" = unknown car)
  reserved_for: string | null = null; // plate sent here but not arrived yet
  detected = 0;                       // car count from the last list-parking-spots

  constructor(readonly name: string, public zone: string, readonly purpose: string, readonly car_type: string) {}

  get available(): boolean {
    return this.purpose === SpotPurpose.Park && !this.broken && !this.maintenance &&
      this.occupant === null && this.reserved_for === null;
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
  openRequestedAt: number | null = null;
  openRetries = 0;

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
}

export interface ExitLane {
  spot: string;
  gate: string | null;
  zone: string;
  releasing: Set<string>;  // paid plates sent to leavepark, not out yet
}

/** Public fields mirror CarView; the camelCase ones are internal bookkeeping (real clock). */
export interface Car extends CarView {
  arrivedReal: number | null;
  dispatchedReal: number | null;
  parkedReal: number | null;
  leftSpotReal: number | null;
  dispatchRetries: number;
  chargeScheduled: boolean;
}

function newCar(plate: string, carType: string, planned: number | null, status: CarStatus, extra: Partial<Car> = {}): Car {
  return {
    plate, car_type: carType, planned_minutes: planned, status,
    entry_lane: null, exit_lane: null, arrived_at: null, spot: null, parked_at: null, left_spot_at: null,
    exit_at: null, charge_parking: null, charge_electric: null, charge_attempts: 0, charge_override: null,
    paid: null, payment_ok: null, left_at: null,
    arrivedReal: null, dispatchedReal: null, parkedReal: null, leftSpotReal: null, dispatchRetries: 0,
    chargeScheduled: false,
    ...extra,
  };
}

export function publicCar(c: Car): CarView {
  const { arrivedReal, dispatchedReal, parkedReal, leftSpotReal, dispatchRetries, chargeScheduled, ...view } = c;
  return view;
}

const AT_EXIT: CarStatus[] = ["at_exit", "invoiced", "payment_mismatch", "released"];
const MID_ENTRY: CarStatus[] = ["dispatching", "dispatched"];
const DEAD: CarStatus[] = ["turned_away", "neglected", "lost", "unknown"];

interface Timer { due: number; label: string; fn: Callback; done: boolean }

export interface ControllerDeps {
  sim: SimApi;
  cfg: Settings;
  store: Store;
  log?: Logger;
  /** Injected topologies (tests); otherwise loaded from cfg.topologyDir. */
  topologies?: Topology[];
  /** Where resyncs are scheduled; defaults to the controller's own serial queue. */
  queue?: TaskQueue;
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
  entryLanes = new Map<string, EntryLane>();
  exitLanes = new Map<string, ExitLane>();
  cars = new Map<string, Car>();                  // active cars by plate
  recentPaid = new Map<string, number>();         // plate -> when its paid session ended
  private scaleSamples: number[] = [];            // game seconds per real second, per completed stay
  private simSettingsSpeed: number | null = null; // GameSpeedMultiplier from the simulator's settings.json
  timers: Timer[] = [];

  completed: SessionView[] = [];
  feed: FeedItem[] = [];
  counters: Counters = {
    arrived: 0, admitted: 0, turned_away: 0, neglected: 0, exited: 0, revenue: 0, payment_mismatches: 0,
    repeat_exits: 0, escaped: 0, penalties: 0, fines: 0, command_errors: 0,
  };

  constructor(deps: ControllerDeps) {
    this.sim = deps.sim;
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.log = deps.log ?? console;
    this.allocator = getAllocator(this.cfg.allocationStrategy);
    this.topologyCandidates = deps.topologies;
    this.queue = deps.queue ?? new SerialQueue((err) => this.log.error(`controller task failed: ${(err as Error)?.stack ?? err}`));
    this.simSettingsSpeed = readSimGameSpeed(this.cfg.simSettingsFile);
  }

  /** Game seconds per real second (= the simulator's GameSpeedMultiplier), and where
   * that figure came from. See the "game clock" section of config.ts. */
  get timeScaleInfo(): { value: number; source: TimeScaleSource } {
    if (this.cfg.gameSpeed) return { value: this.cfg.gameSpeed, source: "configured" };
    if (this.scaleSamples.length >= this.cfg.timeScaleMinSamples) return { value: median(this.scaleSamples), source: "learned" };
    if (this.simSettingsSpeed) return { value: this.simSettingsSpeed, source: "simulator settings" };
    return { value: 1, source: "default" };
  }

  get timeScale(): number {
    return this.timeScaleInfo.value;
  }

  /** Real seconds for a duration the simulator measures in game time. */
  real(gameS: number): number {
    return gameS / this.timeScale;
  }

  private learnTimeScale(car: Car) {
    // A car stays exactly its planned game minutes, so planned / measured-real
    // recovers the game speed without it having to be configured anywhere.
    if (car.planned_minutes && car.parkedReal && car.leftSpotReal) {
      const realS = car.leftSpotReal - car.parkedReal;
      if (realS > 5) {
        const ratio = (car.planned_minutes * 60) / realS;
        if (ratio > 0.1 && ratio < 20) {
          this.scaleSamples.push(ratio);
          if (this.scaleSamples.length > this.cfg.timeScaleSamples) this.scaleSamples.shift();
        }
      }
    }
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
      this.entryLanes = new Map(this.topology.entry_lanes.map((l) => [l.spot, { ...l, queue: [], current: null }]));
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
    if (speed && this.simSettingsSpeed && speed !== this.simSettingsSpeed) {
      this.note("info", `simulator game speed changed ${this.simSettingsSpeed} -> ${speed}; relearning`);
      this.scaleSamples = [];
    }
    this.simSettingsSpeed = speed;
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

  /** Feed recent logged events back through the handlers with commands disabled. */
  async replay(): Promise<void> {
    const records = this.store.eventsSince(Date.now() - this.cfg.replayWindowS * 1000);
    const newest = records.reduce((m, r) => Math.max(m, tsOf(r._received_at) ?? 0), 0);
    if (nowS() - newest > this.cfg.replayMaxGapS) {
      this.log.info(`event log is ${newest ? `${Math.round(nowS() - newest)}s` : "empty/too"} old - ` +
        "simulator likely restarted since; starting fresh");
      return;
    }
    this.replaying = true;
    try {
      for (const r of records) await this.handle(r);
    } finally {
      this.replaying = false;
    }
    this.log.info(`replayed ${records.length} events`);
  }

  /** Make replayed/remembered state agree with what the sensors report right now.
   * startup=false (a live resync) leaves lanes alone: a car may be mid-dispatch. */
  async reconcile(startup = true): Promise<void> {
    if (startup) this.reconcileLanes();
    for (const s of this.spots.values()) {
      if (s.purpose !== SpotPurpose.Park) continue;
      if (s.detected && !s.occupant) {
        s.occupant = "?";
      } else if (!s.detected && s.occupant) {
        const car = this.cars.get(s.occupant);
        if (car && car.status === "parked") this.cars.delete(car.plate);
        s.occupant = null;
      }
    }
    for (const car of [...this.cars.values()]) {
      const sensor = car.exit_lane ? this.spots.get(car.exit_lane) : undefined;
      if (AT_EXIT.includes(car.status) && !sensor?.detected) this.cars.delete(car.plate);
      else if (car.status === "at_exit") this.scheduleCharge(car.plate, this.real(this.cfg.exitChargeDelayGameS));
      else if (car.status === "released") await this.release(car);
      else if (DEAD.includes(car.status)) this.cars.delete(car.plate);
    }
  }

  private reconcileLanes() {
    const now = nowS();
    for (const s of this.spots.values()) s.reserved_for = null; // nobody is mid-dispatch after a (re)start
    for (const lane of this.entryLanes.values()) {
      const sensor = this.spots.get(lane.spot);
      if (lane.current) {
        const car = this.cars.get(lane.current);
        if (car && MID_ENTRY.includes(car.status)) this.cars.delete(car.plate);
        lane.current = null;
      }
      lane.queue = lane.queue.filter((plate) => {
        const car = this.cars.get(plate);
        const alive = !!car && !!sensor?.detected &&
          now - (car.arrivedReal ?? 0) < this.real(this.cfg.entryPatienceGameS);
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
      const now = nowS();
      if (this.lastEventReal && now - this.lastEventReal > this.real(this.cfg.resyncAfterSilenceGameS)) {
        // The simulator was probably restarted or reloaded while we kept running.
        this.maybeResync(`no events for ${Math.round(now - this.lastEventReal)}s`);
      }
      this.lastEventReal = now;
    }

    switch (e.EventClass) {
      case EventClass.CarSpotAction: return this.routeCarEvent(e);
      case EventClass.GateAction: return this.onGate(e);
      case EventClass.PaymentMade: return this.onPayment(e);
      case EventClass.ComponentBroken: return this.onComponent(e, true);
      case EventClass.ComponentFixed: return this.onComponent(e, false);
      case EventClass.Penalty: return this.onPenalty(e);
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
      entry_lane: lane.spot, arrived_at: e.ServerDateTime ?? null, arrivedReal: tsOf(e._received_at) ?? nowS(),
    });
    this.cars.set(plate, car);
    this.counters.arrived++;

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
    if (lane.current || !lane.queue.length) return;
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
    car.dispatchedReal = nowS();
    lane.current = plate;
    const send = () => this.sendToSpot(plate, lane);
    if (gate) await this.whenGateOpen(gate, send);
    else await send();
  }

  private async sendToSpot(plate: string, lane: EntryLane) {
    const car = this.cars.get(plate);
    if (!car || lane.current !== plate || !car.spot) return;
    if (await this.cmd("goto", () => this.sim.carGoto(plate, car.spot!), [plate, car.spot])) {
      car.status = "dispatched";
      car.dispatchedReal = nowS();
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
      else this.later(this.real(this.cfg.gateCloseDelayGameS), `close ${lane.gate}`, () => this.closeGateIfIdle(lane.gate));
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
    await this.cmd("goto", () => this.sim.carGoto(car.plate, Destination.LeavePark), [car.plate, Destination.LeavePark]);
  }

  // ---------------------------------------------------------------------------
  // parking spots
  // ---------------------------------------------------------------------------
  private async onSpotIn(e: EventRecord) {
    const plate = str(e, "CarPlateNumber")!, name = str(e, "SpotName")!;
    let spot = this.spots.get(name);
    if (!spot) this.spots.set(name, (spot = new Spot(name, "", SpotPurpose.Park, CarType.Any)));
    const car = this.cars.get(plate) ?? this.adopt(e);
    if (car.spot && car.spot !== name) {
      this.note("warn", `${plate} parked in ${name}, was sent to ${car.spot}`);
      const other = this.spots.get(car.spot);
      if (other?.reserved_for === plate) other.reserved_for = null;
    }
    if (spot.reserved_for === plate) spot.reserved_for = null;
    spot.occupant = plate;
    car.spot = name;
    car.status = "parked";
    car.parked_at = e.ServerDateTime ?? null;
    car.parkedReal = tsOf(e._received_at);
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
    if (spot && (spot.occupant === plate || spot.occupant === "?")) spot.occupant = null;
    const car = this.cars.get(plate) ?? this.adopt(e);
    car.left_spot_at = e.ServerDateTime ?? null;
    car.leftSpotReal = tsOf(e._received_at);
    this.learnTimeScale(car);
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
  private async onExitIn(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    const car = this.cars.get(plate) ?? this.adopt(e);
    car.exit_lane = lane.spot;
    car.exit_at = e.ServerDateTime ?? null;
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
    this.scheduleCharge(plate, this.real(this.cfg.exitChargeDelayGameS));
  }

  scheduleCharge(plate: string, delayS: number): void {
    const car = this.cars.get(plate);
    if (this.replaying || !car || car.chargeScheduled) return; // after a replay, reconcile() reschedules
    car.chargeScheduled = true;
    this.later(delayS, `charge ${plate}`, () => this.charge(plate));
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
    const realS = car.parkedReal && car.leftSpotReal
      ? car.leftSpotReal - car.parkedReal
      : simSecondsBetween(car.parked_at, car.left_spot_at); // wall-clock stamps
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
    car.status = "released";
    const lane = car.exit_lane ? this.exitLanes.get(car.exit_lane) : undefined;
    lane?.releasing.add(car.plate);
    const gate = lane?.gate ? this.gates.get(lane.gate) : undefined;
    const leave = () => this.cmd("goto", () => this.sim.carGoto(car.plate, Destination.LeavePark), [car.plate, Destination.LeavePark]);
    if (lane?.gate && (!gate || !gate.operable)) {
      this.note("warn", `exit gate ${lane.gate} not operable - ${car.plate} waits`);
      return;
    }
    if (gate) await this.whenGateOpen(gate, leave);
    else await leave();
  }

  private async onExitOut(e: EventRecord, lane: ExitLane) {
    const plate = str(e, "CarPlateNumber")!;
    const car = this.cars.get(plate) ?? this.adopt(e);
    if (car.status !== "released") {
      this.counters.escaped++;
      this.note("error", `${plate} left without being released (status ${car.status})`);
    }
    lane.releasing.delete(plate);
    this.counters.exited++;
    this.finish(car, e);
    this.later(this.real(this.cfg.gateCloseDelayGameS), `close ${lane.gate}`, () => this.closeGateIfIdle(lane.gate));
  }

  // ---------------------------------------------------------------------------
  // penalties, gates & components
  // ---------------------------------------------------------------------------
  private onPenalty(e: EventRecord) {
    this.counters.penalties++;
    this.counters.fines += Number(e.FineAmount) || 0;
    const reason = str(e, "Reason") ?? "";
    this.note("error", `PENALTY ${e.FineAmount}: ${reason} (${e.ComponentName})`);

    const car = this.carByComponent(str(e, "ComponentName"));
    if (!car || car.status !== "invoiced") return;
    const lowered = reason.toLowerCase();
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

  private rebill(car: Car, override: number | null) {
    car.charge_parking = car.charge_electric = null;
    car.charge_override = override;
    car.status = "at_exit";
    if (car.charge_attempts < this.cfg.maxChargeAttempts) this.scheduleCharge(car.plate, this.real(this.cfg.exitChargeRetryGameS));
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
    gate.state = str(e, "Action")!;
    if (gate.state === GateState.Open) {
      await this.gateOpened(gate);
    } else if (gate.state === GateState.Closed && gate.onOpen.length) {
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
    if (gate.state !== GateState.Opening) await this.requestOpen(gate);
    else if (gate.openRequestedAt === null) gate.openRequestedAt = nowS(); // opening per sync: still arm the timeout
  }

  private async requestOpen(gate: Gate) {
    if (await this.cmd("open", () => this.sim.openGate(gate.name), [gate.name])) {
      gate.state = GateState.Opening;
      gate.openRequestedAt = nowS();
    }
  }

  /** The simulator does not always confirm an opening: re-send once, then assume open. */
  private async checkGateTimeouts(now: number) {
    for (const gate of this.gates.values()) {
      if (!gate.onOpen.length || gate.openRequestedAt === null) continue;
      if (now - gate.openRequestedAt < this.real(this.cfg.gateOpenTimeoutGameS)) continue;
      if (gate.openRetries === 0) {
        gate.openRetries = 1;
        this.note("warn", `${gate.name} did not confirm opening, re-sending open`);
        await this.requestOpen(gate);
      } else {
        this.note("warn", `${gate.name} still unconfirmed, assuming it is open`);
        gate.state = GateState.Open;
        await this.gateOpened(gate);
      }
    }
  }

  gateBusy(name: string): boolean {
    return [...this.entryLanes.values()].some((l) => l.gate === name && (l.current || l.queue.length)) ||
      [...this.exitLanes.values()].some((l) => l.gate === name && l.releasing.size > 0);
  }

  async closeGateIfIdle(name: string | null): Promise<void> {
    const gate = name ? this.gates.get(name) : undefined;
    if (gate && gate.operable && !this.gateBusy(gate.name) && !gate.onOpen.length &&
        (gate.state === GateState.Open || gate.state === GateState.Opening)) {
      if (await this.cmd("close", () => this.sim.closeGate(gate.name), [gate.name])) gate.state = GateState.Closing;
    }
  }

  private async onComponent(e: EventRecord, broken: boolean) {
    const name = str(e, "Name") ?? "", kind = str(e, "Type");
    const target = kind === ComponentType.BarrierGate ? this.gates.get(name) : this.spots.get(name);
    if (target) {
      target.broken = broken;
      if (!broken) target.maintenance = false;
    }
    this.note(broken ? "error" : "info", `${kind} ${name} ${broken ? "BROKEN" : "fixed"}`);
    if (!broken) for (const lane of this.entryLanes.values()) await this.pumpEntry(lane);
  }

  // ---------------------------------------------------------------------------
  // housekeeping
  // ---------------------------------------------------------------------------
  async tick(): Promise<void> {
    const now = nowS();
    for (const t of this.timers.filter((t) => t.due <= now)) await this.runTimer(t);
    await this.checkGateTimeouts(now);
    for (const lane of this.entryLanes.values()) await this.checkDispatchTimeout(lane, now);
    const horizon = now - this.real(this.cfg.repeatExitWindowGameS);
    for (const [plate, t] of this.recentPaid) if (t < horizon) this.recentPaid.delete(plate);
  }

  private async checkDispatchTimeout(lane: EntryLane, now: number) {
    const car = lane.current ? this.cars.get(lane.current) : undefined;
    if (!car?.dispatchedReal || now - car.dispatchedReal <= this.real(this.cfg.entryDispatchTimeoutGameS)) return;
    if (car.dispatchRetries < this.cfg.maxDispatchRetries) {
      car.dispatchRetries++;
      car.dispatchedReal = now;
      this.note("warn", `${car.plate} has not left ${lane.spot}, re-sending goto ${car.spot}`);
      return this.sendToSpot(car.plate, lane);
    }
    this.note("error", `${car.plate} stuck at ${lane.spot}, releasing the lane`);
    const spot = car.spot ? this.spots.get(car.spot) : undefined;
    if (spot?.reserved_for === car.plate) spot.reserved_for = null;
    car.status = "lost";
    car.spot = null;
    lane.current = null;
    await this.pumpEntry(lane);
  }

  /**
   * Run fn after delayS. While running, each timer fires on its own setTimeout (through
   * the serial queue) so gate closes are on time rather than rounded up to the next
   * tick; tick() still sweeps anything due, which is also how tests advance time.
   */
  later(delayS: number, label: string, fn: Callback): void {
    if (this.replaying) return; // reconcile() re-arms whatever is still relevant after a replay
    const timer: Timer = { due: nowS() + delayS, label, fn, done: false };
    this.timers.push(timer);
    if (this.started) setTimeout(() => this.queue.push(() => this.runTimer(timer)), delayS * 1000);
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

  /** Remove a car record and anything it still holds (spot, lanes). */
  private forget(car: Car) {
    for (const s of this.spots.values()) {
      if (s.occupant === car.plate) s.occupant = null;
      if (s.reserved_for === car.plate) s.reserved_for = null;
    }
    for (const lane of this.exitLanes.values()) lane.releasing.delete(car.plate);
    this.cars.delete(car.plate);
  }

  private finish(car: Car, e: EventRecord) {
    car.left_at = e.ServerDateTime ?? null;
    if (!["neglected", "turned_away", "lost"].includes(car.status)) car.status = "gone";
    if (car.payment_ok) this.recentPaid.set(car.plate, nowS());
    const session: SessionView = { ...publicCar(car), parked_seconds: simSecondsBetween(car.parked_at, car.left_spot_at) };
    this.completed.push(session);
    if (this.completed.length > this.cfg.completedSessionsSize) this.completed.shift();
    if (!this.replaying) this.store.recordSession(session); // already stored the first time round
    this.cars.delete(car.plate);
  }

  private async cmd(what: string, fn: () => Promise<void>, args: (string | number)[]): Promise<boolean> {
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
      ms: Math.round((performance.now() - t0) * 10) / 10,
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
  // read model for the web layer
  // ---------------------------------------------------------------------------
  snapshot(): StateSnapshot {
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
    const spots = [...this.spots.values()]
      .sort((a, b) => a.purpose.localeCompare(b.purpose) || spotNumber(a.name) - spotNumber(b.name))
      .map((s) => ({
        name: s.name, zone: s.zone, purpose: s.purpose, car_type: s.car_type, broken: s.broken,
        maintenance: s.maintenance, occupant: s.occupant, reserved_for: s.reserved_for, detected: s.detected,
        available: s.available,
      }));
    return {
      synced: this.synced,
      time_scale: Math.round(this.timeScale * 1000) / 1000,
      time_scale_source: this.timeScaleInfo.source,
      topology: this.topology ? { name: this.topology.name, source: this.topology.source ?? "" } : null,
      zones,
      spots,
      gates: [...this.gates.values()].map((g) => ({ name: g.name, zone: g.zone, state: g.state, broken: g.broken, maintenance: g.maintenance })),
      entry_lanes: [...this.entryLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, queue: [...l.queue], current: l.current })),
      exit_lanes: [...this.exitLanes.values()].map((l) => ({ spot: l.spot, gate: l.gate, zone: l.zone, releasing: [...l.releasing].sort() })),
      active_cars: [...this.cars.values()].map(publicCar),
      recent_sessions: this.completed.slice(-50),
      counters: { ...this.counters },
      feed: this.feed.slice(-100),
    };
  }
}
