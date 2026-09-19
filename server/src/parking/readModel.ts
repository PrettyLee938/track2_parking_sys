import { SpotPurpose, type Counters, type FeedItem, type SessionView, type StateSnapshot, type TimeseriesPoint, type ZoneSummary } from "@gpa/shared";
import { spotNumber } from "../allocation";
import { publicCar, type Car, type EntryLane, type ExitLane, type Gate, type Spot } from "./state";

export interface ReadModelContext {
  readonly cfg: { statsSampleS: number; statsSampleKeep: number; completedSessionsSize: number };
  synced: boolean;
  readonly timeScale: number;
  readonly timeScaleInfo: { source: StateSnapshot["time_scale_source"] };
  topology: { name: string; source?: string } | null;
  spots: Map<string, Spot>;
  gates: Map<string, Gate>;
  entryLanes: Map<string, EntryLane>;
  exitLanes: Map<string, ExitLane>;
  cars: Map<string, Car>;
  completed: SessionView[];
  counters: Counters;
  feed: FeedItem[];
  timeseries: TimeseriesPoint[];
  lastSampleReal: number;
}

export function zoneSummaries(ctx: ReadModelContext): Record<string, ZoneSummary> {
  const zones: Record<string, ZoneSummary> = {};
  for (const spot of ctx.spots.values()) {
    if (spot.purpose !== SpotPurpose.Park) continue;
    const zone = (zones[spot.zone || "-"] ??= { total: 0, occupied: 0, reserved: 0, free: 0, out_of_service: 0 });
    zone.total++;
    if (spot.broken || spot.maintenance) zone.out_of_service++;
    else if (spot.occupant) zone.occupied++;
    else if (spot.reserved_for) zone.reserved++;
    else zone.free++;
  }
  return zones;
}

export function sample(ctx: ReadModelContext, now: number): void {
  if (!ctx.synced || now - ctx.lastSampleReal < ctx.cfg.statsSampleS) return;
  ctx.lastSampleReal = now;
  const total = { occupied: 0, reserved: 0, free: 0, out_of_service: 0, capacity: 0 };
  for (const summary of Object.values(zoneSummaries(ctx))) {
    total.occupied += summary.occupied;
    total.reserved += summary.reserved;
    total.free += summary.free;
    total.out_of_service += summary.out_of_service;
    total.capacity += summary.total;
  }
  const queued = [...ctx.entryLanes.values()].reduce((count, lane) => count + lane.queue.length, 0);
  ctx.timeseries.push({ t: new Date(now * 1000).toISOString(), ...total, queued });
  if (ctx.timeseries.length > ctx.cfg.statsSampleKeep) ctx.timeseries.shift();
}

export function snapshot(ctx: ReadModelContext): StateSnapshot {
  const spots = [...ctx.spots.values()]
    .sort((a, b) => a.purpose.localeCompare(b.purpose) || spotNumber(a.name) - spotNumber(b.name))
    .map((spot) => ({
      name: spot.name, zone: spot.zone, purpose: spot.purpose, car_type: spot.car_type,
      broken: spot.broken, maintenance: spot.maintenance, occupant: spot.occupant,
      occupants: [...spot.occupants], reserved_for: spot.reserved_for, detected: spot.detected,
      available: spot.available,
    }));
  return {
    synced: ctx.synced,
    time_scale: Math.round(ctx.timeScale * 1000) / 1000,
    time_scale_source: ctx.timeScaleInfo.source,
    topology: ctx.topology ? { name: ctx.topology.name, source: ctx.topology.source ?? "" } : null,
    zones: zoneSummaries(ctx),
    spots,
    gates: [...ctx.gates.values()].map((gate) => ({
      name: gate.name, zone: gate.zone, state: gate.state, broken: gate.broken, maintenance: gate.maintenance, hold: gate.hold,
    })),
    entry_lanes: [...ctx.entryLanes.values()].map((lane) => ({ ...lane, queue: [...lane.queue] })),
    exit_lanes: [...ctx.exitLanes.values()].map((lane) => ({ ...lane, releasing: [...lane.releasing].sort() })),
    active_cars: [...ctx.cars.values()].map(publicCar),
    recent_sessions: ctx.completed.slice(-50),
    counters: { ...ctx.counters },
    feed: ctx.feed.slice(-100),
  };
}
