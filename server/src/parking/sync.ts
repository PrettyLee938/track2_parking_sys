import { CarType, SpotPurpose, type Counters, type TimeScaleSource } from "@gpa/shared";
import type { Settings } from "../config";
import type { SimApi } from "../simClient";
import { matches, resolve as resolveTopology, type Topology } from "../topology";
import { replay } from "./replay";
import { Gate, Spot, AT_EXIT, DEAD, MID_ENTRY, type Car, type EntryLane, type ExitLane, type Timer } from "./state";
import type { EventRecord, Store } from "../store";
import type { Logger } from "./types";

export interface SyncContext {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly log: Logger;
  readonly topologyCandidates?: Topology[];
  readonly store: Store;
  readonly timeScaleInfo: { value: number; source: TimeScaleSource };
  topology: Topology | null;
  synced: boolean;
  replaying: boolean;
  replayPending: boolean;
  counters: Counters;
  spots: Map<string, Spot>;
  gates: Map<string, Gate>;
  cars: Map<string, Car>;
  timers: Timer[];
  entryLanes: Map<string, EntryLane>;
  exitLanes: Map<string, ExitLane>;
  note(level: "info" | "warn" | "error", message: string): void;
  refreshSimSettingsSpeed(): void;
  reconcile(startup?: boolean): Promise<void>;
  scheduleCharge(plate: string, delaySeconds: number): void;
  release(car: Car): Promise<void>;
  real(gameSeconds: number): number;
  pumpEntry(lane: EntryLane): Promise<void>;
  closeGateIfIdle(name: string | null): Promise<void>;
  handle(event: EventRecord): Promise<void>;
}

export async function sync(ctx: SyncContext, options: { replay?: boolean } = {}): Promise<void> {
  const liveSpots = await ctx.sim.listParkingSpots();
  const liveGates = await ctx.sim.listBarriers();
  ctx.refreshSimSettingsSpeed();
  const entry = new Set(liveSpots.filter((spot) => spot.purpose === SpotPurpose.Entry).map((spot) => spot.name));
  const exit = new Set(liveSpots.filter((spot) => spot.purpose === SpotPurpose.Exit).map((spot) => spot.name));
  if (options.replay) ctx.replayPending = true;
  if (!entry.size && !exit.size) {
    if (ctx.topology) reset(ctx);
    ctx.topology = null;
    ctx.synced = true;
    ctx.note("warn", "simulator has no level loaded yet - waiting for it");
    return;
  }
  const levelChanged = ctx.topology !== null && !matches(ctx.topology, entry, exit);
  const freshLayout = !ctx.topology || levelChanged;
  if (freshLayout) {
    if (levelChanged) {
      ctx.note("warn", "site layout changed (new level?) - resetting state");
      reset(ctx);
    }
    ctx.topology = resolveTopology(liveSpots, liveGates, {
      topologyDir: ctx.cfg.topologyDir, simLevelsDir: ctx.cfg.simLevelsDir,
      maxGateDistance: ctx.cfg.topologyMaxGateDistance, candidates: ctx.topologyCandidates, log: ctx.log,
    });
    ctx.entryLanes = new Map(ctx.topology.entry_lanes.map((lane) => [lane.spot, { ...lane, queue: [], current: null, closed: false }]));
    ctx.exitLanes = new Map(ctx.topology.exit_lanes.map((lane) => [lane.spot, { ...lane, releasing: new Set<string>() }]));
  }
  for (const spot of liveSpots) upsertSpot(ctx, spot);
  if (ctx.replayPending) {
    ctx.replayPending = false;
    await replay(ctx);
  }
  for (const liveGate of liveGates) {
    const gate = ctx.gates.get(liveGate.name) ?? new Gate(liveGate.name, liveGate.zoneParent || "");
    gate.state = liveGate.state;
    gate.broken = liveGate.broken;
    gate.maintenance = liveGate.isUnderMaintenance;
    ctx.gates.set(gate.name, gate);
  }
  await ctx.reconcile(freshLayout);
  ctx.synced = true;
  const parkingSpots = [...ctx.spots.values()].filter((spot) => spot.purpose === SpotPurpose.Park);
  const speed = ctx.timeScaleInfo;
  ctx.note("info", `Synced '${ctx.topology!.name}': ${ctx.entryLanes.size} entries, ${ctx.exitLanes.size} exits, ` +
    `${parkingSpots.length} park spots (${parkingSpots.filter((spot) => spot.available).length} free); tracking ${ctx.cars.size} cars; ` +
    `game speed ${speed.value.toFixed(2)} (${speed.source})`);
  for (const lane of ctx.entryLanes.values()) await ctx.pumpEntry(lane);
  if (ctx.cfg.closeIdleGatesOnSync) {
    const names = new Set([...ctx.entryLanes.values(), ...ctx.exitLanes.values()].map((lane) => lane.gate).filter(Boolean));
    for (const name of names) await ctx.closeGateIfIdle(name);
  }
}

export async function reconcile(ctx: SyncContext, startup = true): Promise<void> {
  if (startup) reconcileLanes(ctx);
  for (const spot of ctx.spots.values()) {
    if (spot.purpose !== SpotPurpose.Park) continue;
    if (spot.detected && !spot.occupants.size) spot.occupants.add("?");
    else if (!spot.detected && spot.occupants.size) {
      for (const plate of spot.occupants) if (ctx.cars.get(plate)?.status === "parked") ctx.cars.delete(plate);
      spot.occupants.clear();
    }
  }
  for (const car of [...ctx.cars.values()]) {
    const sensor = car.exit_lane ? ctx.spots.get(car.exit_lane) : undefined;
    if (AT_EXIT.includes(car.status) && !sensor?.detected) ctx.cars.delete(car.plate);
    else if (car.status === "at_exit") ctx.scheduleCharge(car.plate, ctx.real(ctx.cfg.exitChargeDelayGameS));
    else if (car.status === "released") await ctx.release(car);
    else if (DEAD.includes(car.status)) ctx.cars.delete(car.plate);
  }
}

function reconcileLanes(ctx: SyncContext): void {
  const now = Date.now() / 1000;
  const onTheWay = (plate: string | null) => {
    const car = plate ? ctx.cars.get(plate) : undefined;
    return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering");
  };
  for (const spot of ctx.spots.values()) {
    if (spot.reserved_for && (!onTheWay(spot.reserved_for) || ctx.cars.get(spot.reserved_for)?.spot !== spot.name)) spot.reserved_for = null;
  }
  for (const lane of ctx.entryLanes.values()) {
    const sensor = ctx.spots.get(lane.spot);
    if (lane.current && !onTheWay(lane.current)) lane.current = null;
    lane.queue = lane.queue.filter((plate) => {
      const car = ctx.cars.get(plate);
      const alive = !!car && !!sensor?.detected && now - (car.arrivedReal ?? 0) < ctx.real(ctx.cfg.entryPatienceGameS);
      if (!alive) ctx.cars.delete(plate);
      return alive;
    });
  }
}

function upsertSpot(ctx: SyncContext, live: { name: string; zoneParent?: string; purpose: string; parkingForCarType?: string; broken: boolean; isUnderMaintenance: boolean; detectedCars: number }): void {
  const spot = ctx.spots.get(live.name) ?? new Spot(live.name, live.zoneParent || "", live.purpose, live.parkingForCarType || CarType.Any);
  spot.broken = live.broken;
  spot.maintenance = live.isUnderMaintenance;
  spot.detected = Number(live.detectedCars) || 0;
  ctx.spots.set(spot.name, spot);
}

function reset(ctx: SyncContext): void {
  for (const timer of ctx.timers) timer.done = true;
  ctx.spots = new Map();
  ctx.gates = new Map();
  ctx.cars = new Map();
  ctx.timers = [];
  ctx.entryLanes = new Map();
  ctx.exitLanes = new Map();
}
