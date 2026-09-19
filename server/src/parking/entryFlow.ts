import { CarType, Destination, SpotPurpose, type Counters } from "@gpa/shared";
import type { Allocator } from "../allocation";
import type { Settings } from "../config";
import type { EventRecord } from "../store";
import type { SimApi } from "../simClient";
import { command } from "./commands";
import { integerOrNull, nowSeconds, timestampSeconds } from "./clock";
import { closeGateIfIdle, whenGateOpen } from "./gates";
import { Gate, Spot, newCar, type Car, type EntryLane, type ExitLane } from "./state";

const field = (event: EventRecord, key: string) => event[key] as string | undefined;

export interface EntryContext {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly allocator: Allocator;
  readonly replaying: boolean;
  readonly store: { recordAction(action: { at: string; cmd: string; args: string[]; ok: boolean; error: string | null; ms: number; actor?: string | null }): void };
  readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  feed: { at: string; level: "info" | "warn" | "error"; msg: string }[];
  readonly gates: Map<string, Gate>;
  readonly exitLanes: Map<string, ExitLane>;
  spots: Map<string, Spot>;
  cars: Map<string, Car>;
  entryLanes: Map<string, EntryLane>;
  recentPaid: Map<string, number>;
  counters: Counters;
  note(level: "info" | "warn" | "error", message: string): void;
  real(gameSeconds: number): number;
  whenGateOpen(gate: Gate, callback: () => Promise<unknown> | unknown): Promise<void>;
  closeGateIfIdle(name: string | null): Promise<void>;
  later(delaySeconds: number, label: string, callback: () => Promise<unknown> | unknown): void;
  finish(car: Car, event: EventRecord): void;
  forget(car: Car): void;
  adopt(event: EventRecord): Car;
  learnTimeScale(car: Car): void;
  pumpEntry(lane: EntryLane): Promise<void>;
}

export async function onEntryIn(ctx: EntryContext, event: EventRecord, lane: EntryLane): Promise<void> {
  const plate = field(event, "CarPlateNumber")!;
  const stale = ctx.cars.get(plate);
  if (stale) {
    if ([...ctx.entryLanes.values()].some((candidate) => candidate.queue.includes(plate) || candidate.current === plate)) return;
    ctx.note("warn", `${plate} arrived at ${lane.spot} while recorded as '${stale.status}' - replacing stale record`);
    ctx.forget(stale);
  }
  const car = makeQueuedCar(event, lane.spot);
  ctx.cars.set(plate, car);
  ctx.counters.arrived++;
  ctx.recentPaid.delete(plate);
  if (ctx.replaying) {
    lane.queue.push(plate);
    return;
  }
  if (lane.closed) return turnAway(ctx, car, `entrance ${lane.spot} is closed`);
  const free = ctx.allocator.candidates(car.car_type, lane.zone, ctx.spots.values()).length;
  const waiting = [...ctx.entryLanes.values()]
    .filter((candidate) => ctx.allocator.sharesPool(candidate.zone, lane.zone))
    .reduce((count, candidate) => count + candidate.queue.length, 0);
  if (free - waiting <= 0) return turnAway(ctx, car, "no free spot");
  lane.queue.push(plate);
  ctx.note("info", `${plate} arrived at ${lane.spot} (${car.car_type}, planned ${car.planned_minutes}m), queue=${lane.queue.length}`);
  await pumpEntry(ctx, lane);
}

function makeQueuedCar(event: EventRecord, entryLane: string): Car {
  return {
    ...newCar(field(event, "CarPlateNumber")!, field(event, "CarType") || CarType.Normal, integerOrNull(event.PlannedParkingDurationInMinutes), "queued"),
    entry_lane: entryLane,
    arrived_at: event.ServerDateTime ?? null,
    arrivedReal: timestampSeconds(event._received_at) ?? nowSeconds(),
  };
}

export async function pumpEntry(ctx: EntryContext, lane: EntryLane): Promise<void> {
  if (ctx.replaying || lane.current || !lane.queue.length) return;
  const gate = lane.gate ? ctx.gates.get(lane.gate) : undefined;
  if (lane.gate && (!gate || !gate.operable)) return;
  const plate = lane.queue.shift()!;
  const car = ctx.cars.get(plate)!;
  const spot = ctx.allocator.choose(car.car_type, lane.zone, ctx.spots.values());
  if (!spot) {
    await turnAway(ctx, car, "no suitable spot");
    return pumpEntry(ctx, lane);
  }
  spot.reserved_for = plate;
  car.spot = spot.name;
  car.status = "dispatching";
  car.dispatchedReal = nowSeconds();
  lane.current = plate;
  const send = () => sendToSpot(ctx, plate, lane);
  if (gate) await whenGateOpen(ctx, gate, send);
  else await send();
}

export async function sendToSpot(ctx: EntryContext, plate: string, lane: EntryLane): Promise<void> {
  const car = ctx.cars.get(plate);
  if (!car || lane.current !== plate || !car.spot) return;
  if (await command(ctx, "goto", () => ctx.sim.carGoto(plate, car.spot!), [plate, car.spot])) {
    car.status = "dispatched";
    car.dispatchedReal = nowSeconds();
    ctx.counters.admitted++;
    ctx.note("info", `${plate} -> ${car.spot}`);
  }
}

export async function onEntryOut(ctx: EntryContext, event: EventRecord, lane: EntryLane): Promise<void> {
  const plate = field(event, "CarPlateNumber")!;
  const car = ctx.cars.get(plate);
  if (plate === lane.current) {
    if (car) car.status = "entering";
    lane.current = null;
    if (lane.queue.length) await pumpEntry(ctx, lane);
    else ctx.later(ctx.real(ctx.cfg.gateCloseDelayGameS), `close ${lane.gate}`, () => closeGateIfIdle(ctx, lane.gate));
  } else if (lane.queue.includes(plate)) {
    lane.queue.splice(lane.queue.indexOf(plate), 1);
    car!.status = "neglected";
    ctx.counters.neglected++;
    ctx.note("warn", `${plate} gave up waiting at ${lane.spot}`);
    ctx.finish(car!, event);
  } else if (car?.status === "turned_away") {
    ctx.finish(car, event);
  }
}

async function turnAway(ctx: EntryContext, car: Car, reason: string): Promise<void> {
  car.status = "turned_away";
  ctx.counters.turned_away++;
  ctx.note("warn", `${car.plate} turned away: ${reason}`);
  await command(ctx, "goto", () => ctx.sim.carGoto(car.plate, Destination.LeavePark), [car.plate, Destination.LeavePark]);
}

export async function onSpotIn(ctx: EntryContext, event: EventRecord): Promise<void> {
  const plate = field(event, "CarPlateNumber")!, name = field(event, "SpotName")!;
  const spot = ctx.spots.get(name) ?? new Spot(name, "", SpotPurpose.Park, CarType.Any);
  ctx.spots.set(name, spot);
  const others = [...spot.occupants].filter((occupant) => occupant !== plate && occupant !== "?");
  if (others.length) ctx.note("error", `${plate} parked in ${name}, which still holds ${others.join(", ")}`);
  const car = ctx.cars.get(plate) ?? ctx.adopt(event);
  if (car.spot && car.spot !== name) {
    ctx.note("warn", `${plate} parked in ${name}, was sent to ${car.spot}`);
    const other = ctx.spots.get(car.spot);
    if (other?.reserved_for === plate) other.reserved_for = null;
  }
  if (spot.reserved_for === plate) spot.reserved_for = null;
  spot.occupants.add(plate);
  car.spot = name;
  car.status = "parked";
  car.parked_at = event.ServerDateTime ?? null;
  car.parkedReal = timestampSeconds(event._received_at);
  car.planned_minutes = integerOrNull(event.PlannedParkingDurationInMinutes) || car.planned_minutes;
  const lane = car.entry_lane ? ctx.entryLanes.get(car.entry_lane) : undefined;
  if (lane?.current === plate) {
    lane.current = null;
    await pumpEntry(ctx, lane);
  }
  ctx.note("info", `${plate} parked in ${name}`);
}

export async function onSpotOut(ctx: EntryContext, event: EventRecord): Promise<void> {
  const plate = field(event, "CarPlateNumber")!, name = field(event, "SpotName")!;
  const spot = ctx.spots.get(name);
  if (spot) spot.occupants.delete(spot.occupants.has(plate) ? plate : "?");
  const car = ctx.cars.get(plate) ?? ctx.adopt(event);
  car.left_spot_at = event.ServerDateTime ?? null;
  car.leftSpotReal = timestampSeconds(event._received_at);
  ctx.learnTimeScale(car);
  if (car.status === "parked" || car.status === "unknown") car.status = "to_exit";
  ctx.note("info", `${plate} left ${name}`);
  for (const lane of ctx.entryLanes.values()) await pumpEntry(ctx, lane);
}
