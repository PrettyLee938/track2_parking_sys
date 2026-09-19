import { Destination, type Counters } from "@gpa/shared";
import { chargingCost, parkingCost } from "../billing";
import type { Settings } from "../config";
import type { EventRecord } from "../store";
import type { SimApi } from "../simClient";
import { command } from "./commands";
import { nowSeconds, simSecondsBetween } from "./clock";
import { closeGateIfIdle, whenGateOpen } from "./gates";
import { Gate, Spot, type Car, type EntryLane, type ExitLane } from "./state";

const field = (event: EventRecord, key: string) => event[key] as string | undefined;

export interface ExitContext {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly replaying: boolean;
  readonly timeScale: number;
  readonly gates: Map<string, Gate>;
  readonly entryLanes: Map<string, EntryLane>;
  readonly store: { recordAction(action: { at: string; cmd: string; args: string[]; ok: boolean; error: string | null; ms: number; actor?: string | null }): void };
  readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  feed: { at: string; level: "info" | "warn" | "error"; msg: string }[];
  cars: Map<string, Car>;
  spots: Map<string, Spot>;
  exitLanes: Map<string, ExitLane>;
  recentPaid: Map<string, number>;
  counters: Counters;
  note(level: "info" | "warn" | "error", message: string): void;
  real(gameSeconds: number): number;
  later(delaySeconds: number, label: string, callback: () => Promise<unknown> | unknown): void;
  whenGateOpen(gate: Gate, callback: () => Promise<unknown> | unknown): Promise<void>;
  closeGateIfIdle(name: string | null): Promise<void>;
  pumpEntry(lane: EntryLane): Promise<void>;
  scheduleCharge(plate: string, delaySeconds: number): void;
  finish(car: Car, event: EventRecord): void;
  adopt(event: EventRecord): Car;
}

export async function onExitIn(ctx: ExitContext, event: EventRecord, lane: ExitLane): Promise<void> {
  const plate = field(event, "CarPlateNumber")!;
  if (drivingIn(ctx, plate)) return;
  const car = ctx.cars.get(plate) ?? ctx.adopt(event);
  car.exit_lane = lane.spot;
  car.exit_at = event.ServerDateTime ?? null;
  const held = car.spot ? ctx.spots.get(car.spot) : undefined;
  if (held?.occupants.has(plate)) {
    held.occupants.delete(plate);
    for (const entryLane of ctx.entryLanes.values()) await ctx.pumpEntry(entryLane);
  }
  if (car.charge_parking !== null) return;
  if (car.entry_lane === null && ctx.recentPaid.has(plate)) {
    ctx.counters.repeat_exits++;
    ctx.note("warn", `${plate} back at ${lane.spot} after paying, without entering - not billing again, releasing`);
    car.payment_ok = true;
    return release(ctx, car);
  }
  car.status = "at_exit";
  ctx.scheduleCharge(plate, ctx.real(ctx.cfg.exitChargeDelayGameS));
}

export function scheduleCharge(ctx: ExitContext, plate: string, delaySeconds: number): void {
  const car = ctx.cars.get(plate);
  if (ctx.replaying || !car || car.chargeScheduled) return;
  car.chargeScheduled = true;
  ctx.later(delaySeconds, `charge ${plate}`, () => charge(ctx, plate));
}

async function charge(ctx: ExitContext, plate: string): Promise<void> {
  const car = ctx.cars.get(plate);
  if (!car) return;
  car.chargeScheduled = false;
  if (car.status !== "at_exit" || car.charge_parking !== null) return;
  car.charge_attempts++;
  const gameSeconds = parkedGameSeconds(ctx, car);
  let parking: number;
  let basis: string;
  if (car.charge_override !== null) {
    parking = car.charge_override;
    basis = "amount stated by simulator";
  } else {
    if (gameSeconds === null && !car.planned_minutes) ctx.note("warn", `${plate}: no parking times and no planned duration, billing 1 minute`);
    parking = parkingCost(gameSeconds ?? 60, car.planned_minutes, car.car_type, ctx.cfg);
    basis = `planned ${car.planned_minutes}m, measured ${gameSeconds !== null ? (gameSeconds / 60).toFixed(2) : "?"} game-min`;
  }
  const electric = chargingCost(car.car_type, ctx.cfg);
  if (await command(ctx, "charge", () => ctx.sim.carCharge(plate, parking, electric), [plate, parking, electric])) {
    car.charge_parking = parking;
    car.charge_electric = electric;
    car.status = "invoiced";
    ctx.note("info", `${plate} invoiced ${(parking + electric).toFixed(2)} (${basis})`);
  }
}

function parkedGameSeconds(ctx: ExitContext, car: Car): number | null {
  const realSeconds = car.parkedReal && car.leftSpotReal
    ? car.leftSpotReal - car.parkedReal
    : simSecondsBetween(car.parked_at, car.left_spot_at);
  return realSeconds === null ? null : realSeconds * ctx.timeScale;
}

export async function onPayment(ctx: ExitContext, event: EventRecord): Promise<void> {
  const plate = field(event, "CarPlateNumber")!;
  const amount = Number(event.Amount) || 0;
  const car = ctx.cars.get(plate);
  if (!car || car.charge_parking === null) {
    ctx.note("warn", `payment ${amount.toFixed(2)} from ${plate} with no invoice - ignored`);
    return;
  }
  const expected = car.charge_parking + (car.charge_electric ?? 0);
  car.paid = amount;
  if (Math.abs(amount - expected) <= ctx.cfg.paymentTolerance) {
    car.payment_ok = true;
    ctx.counters.revenue += amount;
    await release(ctx, car);
  } else {
    car.payment_ok = false;
    car.status = "payment_mismatch";
    ctx.counters.payment_mismatches++;
    ctx.note("error", `${plate} paid ${amount.toFixed(2)}, invoice ${expected.toFixed(2)} - NOT releasing`);
  }
}

export async function release(ctx: ExitContext, car: Car): Promise<void> {
  if (ctx.replaying) return;
  car.status = "released";
  car.releasedReal = nowSeconds();
  const lane = car.exit_lane ? ctx.exitLanes.get(car.exit_lane) : undefined;
  lane?.releasing.add(car.plate);
  const gate = lane?.gate ? ctx.gates.get(lane.gate) : undefined;
  const leave = () => command(ctx, "goto", () => ctx.sim.carGoto(car.plate, Destination.LeavePark), [car.plate, Destination.LeavePark]);
  if (lane?.gate && (!gate || !gate.operable)) {
    ctx.note("warn", `exit gate ${lane.gate} not operable - ${car.plate} waits`);
    return;
  }
  if (gate) await whenGateOpen(ctx, gate, leave);
  else await leave();
}

export async function onExitOut(ctx: ExitContext, event: EventRecord, lane: ExitLane): Promise<void> {
  const plate = field(event, "CarPlateNumber")!;
  if (drivingIn(ctx, plate)) return;
  const car = ctx.cars.get(plate) ?? ctx.adopt(event);
  if (car.status !== "released") {
    ctx.counters.escaped++;
    ctx.note("error", `${plate} left without being released (status ${car.status})`);
  }
  lane.releasing.delete(plate);
  ctx.counters.exited++;
  ctx.finish(car, event);
  ctx.later(ctx.real(ctx.cfg.gateCloseDelayGameS), `close ${lane.gate}`, () => closeGateIfIdle(ctx, lane.gate));
}

function drivingIn(ctx: ExitContext, plate: string): boolean {
  const car = ctx.cars.get(plate);
  return !!car && (["dispatching", "dispatched"].includes(car.status) || car.status === "entering");
}
