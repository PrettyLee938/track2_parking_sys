import { CarType, type CarStatus, type Counters, type SessionView } from "@gpa/shared";
import type { Settings } from "../config";
import type { EventRecord, Store } from "../store";
import type { SimApi } from "../simClient";
import { nowSeconds, simSecondsBetween } from "./clock";
import { closeGateIfIdle } from "./gates";
import type { Car, EntryLane, ExitLane, Gate, Spot } from "./state";
import { newCar, publicCar } from "./state";

const field = (event: EventRecord, key: string) => event[key] as string | undefined;

export interface RecoveryContext {
  readonly cfg: Settings;
  readonly replaying: boolean;
  readonly sim: SimApi;
  readonly store: Store;
  readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  feed: { at: string; level: "info" | "warn" | "error"; msg: string }[];
  readonly gates: Map<string, Gate>;
  spots: Map<string, Spot>;
  cars: Map<string, Car>;
  entryLanes: Map<string, EntryLane>;
  exitLanes: Map<string, ExitLane>;
  recentPaid: Map<string, number>;
  counters: Counters;
  completed: SessionView[];
  note(level: "info" | "warn" | "error", message: string): void;
  real(gameSeconds: number): number;
  pumpEntry(lane: EntryLane): Promise<void>;
  sendToSpot(plate: string, lane: EntryLane): Promise<void>;
  closeGateIfIdle(name: string | null): Promise<void>;
}

export async function checkDispatchTimeout(ctx: RecoveryContext, lane: EntryLane, now: number): Promise<void> {
  const car = lane.current ? ctx.cars.get(lane.current) : undefined;
  if (!car?.dispatchedReal || now - car.dispatchedReal <= ctx.real(ctx.cfg.entryDispatchTimeoutGameS)) return;
  if (car.dispatchRetries < ctx.cfg.maxDispatchRetries) {
    car.dispatchRetries++;
    car.dispatchedReal = now;
    ctx.note("warn", `${car.plate} has not left ${lane.spot}, re-sending goto ${car.spot}`);
    return ctx.sendToSpot(car.plate, lane);
  }
  ctx.note("error", `${car.plate} stuck at ${lane.spot}, releasing the lane`);
  const spot = car.spot ? ctx.spots.get(car.spot) : undefined;
  if (spot?.reserved_for === car.plate) spot.reserved_for = null;
  car.status = "lost";
  car.spot = null;
  lane.current = null;
  await ctx.pumpEntry(lane);
}

export function adopt(ctx: RecoveryContext, event: EventRecord): Car {
  const plate = field(event, "CarPlateNumber")!;
  const car = newCar(plate, field(event, "CarType") || CarType.Normal, numberOrNull(event.PlannedParkingDurationInMinutes), "unknown");
  ctx.cars.set(plate, car);
  ctx.note("warn", `adopted unknown car ${plate} at ${event.SpotName}`);
  return car;
}

export function forget(ctx: RecoveryContext, car: Car): void {
  detach(ctx, car);
  ctx.cars.delete(car.plate);
}

export function retire(ctx: RecoveryContext, car: Car, reason: string, status: CarStatus = "lost"): void {
  ctx.note("warn", `${car.plate} ${reason} - closing its record (event lost or simulator restarted)`);
  detach(ctx, car);
  car.status = status;
  ctx.counters.ghosts_retired++;
  finish(ctx, car, { EventClass: "", _received_at: new Date().toISOString() });
}

export async function sweepGhosts(ctx: RecoveryContext, now: number): Promise<void> {
  const gatesToClose = new Set<string>();
  const retiredBefore = ctx.counters.ghosts_retired;
  for (const car of [...ctx.cars.values()]) {
    const quietFor = now - (car.lastSeenReal ?? car.arrivedReal ?? now);
    if (car.status === "released" && car.releasedReal && now - car.releasedReal > ctx.real(ctx.cfg.releaseTimeoutGameS)) {
      const gate = car.exit_lane ? ctx.exitLanes.get(car.exit_lane)?.gate : null;
      retire(ctx, car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
      if (gate) gatesToClose.add(gate);
    } else if (car.status === "parked") {
      const since = car.parkedReal ?? car.lastSeenReal;
      const allowed = ctx.real((car.planned_minutes ?? 0) * 60 + ctx.cfg.parkedOverstayGameS);
      if (since && now - since > allowed) retire(ctx, car, `is still recorded in ${car.spot} well past its planned ${car.planned_minutes}m`);
    } else if (car.status === "queued") {
      if (now - (car.arrivedReal ?? now) > ctx.real(ctx.cfg.entryPatienceGameS + 60)) retire(ctx, car, `is still queued at ${car.entry_lane} past the give-up time`);
    } else if (["to_exit", "at_exit", "invoiced", "payment_mismatch", "entering", "unknown"].includes(car.status)) {
      if (quietFor > ctx.real(ctx.cfg.staleCarGameS)) retire(ctx, car, `has had no events for ${Math.round(quietFor)}s (status ${car.status})`);
    }
  }
  for (const gate of gatesToClose) await closeGateIfIdle(ctx, gate);
  if (ctx.counters.ghosts_retired > retiredBefore) for (const lane of ctx.entryLanes.values()) await ctx.pumpEntry(lane);
}

export function finish(ctx: RecoveryContext, car: Car, event: EventRecord): void {
  car.left_at = event.ServerDateTime ?? null;
  if (!["neglected", "turned_away", "lost"].includes(car.status)) car.status = "gone";
  if (car.payment_ok) ctx.recentPaid.set(car.plate, nowSeconds());
  const session: SessionView = { ...publicCar(car), parked_seconds: simSecondsBetween(car.parked_at, car.left_spot_at) };
  ctx.completed.push(session);
  if (ctx.completed.length > ctx.cfg.completedSessionsSize) ctx.completed.shift();
  if (!ctx.replaying) ctx.store.recordSession(session);
  ctx.cars.delete(car.plate);
}

function detach(ctx: RecoveryContext, car: Car): void {
  for (const spot of ctx.spots.values()) {
    spot.occupants.delete(car.plate);
    if (spot.reserved_for === car.plate) spot.reserved_for = null;
  }
  for (const lane of ctx.entryLanes.values()) {
    lane.queue = lane.queue.filter((plate) => plate !== car.plate);
    if (lane.current === car.plate) lane.current = null;
  }
  for (const lane of ctx.exitLanes.values()) lane.releasing.delete(car.plate);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
