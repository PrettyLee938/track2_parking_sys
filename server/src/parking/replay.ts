import { Destination, type Counters } from "@gpa/shared";
import type { Settings } from "../config";
import type { ActionRecord, EventRecord, Store } from "../store";
import { timestampSeconds } from "./clock";
import { MID_ENTRY, type Car, type EntryLane, type ExitLane, type Spot } from "./state";
import type { Topology } from "../topology";

export interface ReplayContext {
  readonly cfg: Settings;
  readonly store: Store;
  readonly log: { info(message: string): void };
  replaying: boolean;
  cars: Map<string, Car>;
  spots: Map<string, Spot>;
  entryLanes: Map<string, EntryLane>;
  exitLanes: Map<string, ExitLane>;
  counters: Counters;
  handle(event: EventRecord): Promise<void>;
}

export async function replay(ctx: ReplayContext): Promise<void> {
  const since = Date.now() - ctx.cfg.replayWindowS * 1000;
  const events = ctx.store.eventsSince(since);
  const newest = events.reduce((latest, event) => Math.max(latest, timestampSeconds(event._received_at) ?? 0), 0);
  if (Date.now() / 1000 - newest > ctx.cfg.replayMaxGapS) {
    ctx.log.info(`event log is ${newest ? `${Math.round(Date.now() / 1000 - newest)}s` : "empty/too"} old - simulator likely restarted since; starting fresh`);
    return;
  }
  const actions = ctx.store.actionsSince(since).filter((action) => action.ok && (action.cmd === "goto" || action.cmd === "charge"));
  const timeline = [
    ...events.map((event) => ({ t: timestampSeconds(event._received_at) ?? 0, event: event as EventRecord | null, action: null as ActionRecord | null })),
    ...actions.map((action) => ({ t: timestampSeconds(action.at) ?? 0, event: null, action })),
  ].sort((a, b) => a.t - b.t);
  ctx.replaying = true;
  try {
    for (const item of timeline) {
      if (item.event) await ctx.handle(item.event);
      else applyRecordedAction(ctx, item.action!);
    }
  } finally {
    ctx.replaying = false;
  }
  ctx.log.info(`replayed ${events.length} events and ${actions.length} commands`);
}

export function applyRecordedAction(ctx: ReplayContext, action: ActionRecord): void {
  const plate = action.args[0];
  const car = ctx.cars.get(plate);
  if (!car) return;
  const time = timestampSeconds(action.at);
  if (action.cmd === "charge") {
    car.charge_parking = Number(action.args[1]);
    car.charge_electric = Number(action.args[2]) || 0;
    car.charge_attempts++;
    if (!["released", "payment_mismatch", "gone"].includes(car.status)) car.status = "invoiced";
    return;
  }
  const target = action.args[1];
  const lane = car.entry_lane ? ctx.entryLanes.get(car.entry_lane) : undefined;
  const notYetIn = car.status === "queued" || car.status === "dispatching";
  if (target === Destination.LeavePark) {
    if (notYetIn) {
      if (lane) lane.queue = lane.queue.filter((queued) => queued !== plate);
      car.status = "turned_away";
      ctx.counters.turned_away++;
    } else {
      car.status = "released";
      car.releasedReal = time;
      if (car.exit_lane) ctx.exitLanes.get(car.exit_lane)?.releasing.add(plate);
    }
  } else if (target !== Destination.Exit && lane) {
    lane.queue = lane.queue.filter((queued) => queued !== plate);
    if (notYetIn || car.status === "dispatched") lane.current = plate;
    const previous = car.spot ? ctx.spots.get(car.spot) : undefined;
    if (previous?.reserved_for === plate) previous.reserved_for = null;
    const spot = ctx.spots.get(target);
    if (spot && !spot.occupants.has(plate)) spot.reserved_for = plate;
    car.spot = target;
    if (notYetIn) {
      car.status = "dispatched";
      ctx.counters.admitted++;
    }
    car.dispatchedReal = time;
  }
}
