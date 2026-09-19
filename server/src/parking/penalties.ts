import { CORRECT_AMOUNT_PATTERN, OCCUPIED_SPOT_PATTERN, PenaltyReason, type Counters } from "@gpa/shared";
import type { Allocator } from "../allocation";
import type { Settings } from "../config";
import type { EventRecord } from "../store";
import type { SimApi } from "../simClient";
import { command } from "./commands";
import type { Gate, Spot, Car, EntryLane, ExitLane } from "./state";

const field = (event: EventRecord, key: string) => event[key] as string | undefined;

export interface PenaltyContext {
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
  counters: Counters;
  note(level: "info" | "warn" | "error", message: string): void;
  real(gameSeconds: number): number;
  scheduleCharge(plate: string, delaySeconds: number): void;
  release(car: Car): Promise<void>;
}

export async function onPenalty(ctx: PenaltyContext, event: EventRecord): Promise<void> {
  ctx.counters.penalties++;
  ctx.counters.fines += Number(event.FineAmount) || 0;
  const reason = field(event, "Reason") ?? "";
  ctx.note("error", `PENALTY ${event.FineAmount}: ${reason} (${event.ComponentName})`);
  const car = carByComponent(ctx, field(event, "ComponentName"));
  const lowered = reason.toLowerCase();
  if (lowered.includes(PenaltyReason.OccupiedSpot)) return occupiedSpotPenalty(ctx, reason, car);
  if (car && lowered.includes(PenaltyReason.AlreadyPaid) && ["at_exit", "invoiced", "payment_mismatch"].includes(car.status)) {
    ctx.note("warn", `${car.plate} has already paid according to the simulator - releasing`);
    car.payment_ok = true;
    return ctx.release(car);
  }
  if (!car || car.status !== "invoiced") return;
  if (lowered.includes(PenaltyReason.ChargeNotAtExit)) {
    rebill(ctx, car, null);
  } else if (lowered.includes(PenaltyReason.ChargedWrongly) && ctx.cfg.rechargeOnWrongAmount) {
    const amount = CORRECT_AMOUNT_PATTERN.exec(reason)?.[1];
    if (amount) rebill(ctx, car, Number(amount));
  }
}

async function occupiedSpotPenalty(ctx: PenaltyContext, reason: string, car: Car | undefined): Promise<void> {
  const spotName = OCCUPIED_SPOT_PATTERN.exec(reason)?.[1]?.trim();
  const spot = spotName ? ctx.spots.get(spotName) : undefined;
  if (!spot) return;
  if (!spot.occupants.size) spot.occupants.add("?");
  if (spot.reserved_for === car?.plate) spot.reserved_for = null;
  if (ctx.replaying || !car || car.spot !== spot.name || !(isDispatching(car))) return;
  const lane = car.entry_lane ? ctx.entryLanes.get(car.entry_lane) : undefined;
  const alternate = ctx.allocator.choose(car.car_type, lane?.zone ?? "", ctx.spots.values());
  if (!alternate) {
    ctx.note("error", `${car.plate}: ${spot.name} is taken and no other spot is free`);
    return;
  }
  alternate.reserved_for = car.plate;
  car.spot = alternate.name;
  car.dispatchRetries = 0;
  car.dispatchedReal = Date.now() / 1000;
  ctx.note("warn", `${spot.name} is occupied - redirecting ${car.plate} to ${alternate.name}`);
  await command(ctx, "goto", () => ctx.sim.carGoto(car.plate, alternate.name), [car.plate, alternate.name]);
}

function isDispatching(car: Car): boolean {
  return ["dispatching", "dispatched"].includes(car.status) || car.status === "entering";
}

function rebill(ctx: PenaltyContext, car: Car, override: number | null): void {
  car.charge_parking = car.charge_electric = null;
  car.charge_override = override;
  car.status = "at_exit";
  if (car.charge_attempts < ctx.cfg.maxChargeAttempts) ctx.scheduleCharge(car.plate, ctx.real(ctx.cfg.exitChargeRetryGameS));
  else ctx.note("error", `${car.plate}: invoice rejected ${car.charge_attempts}x, giving up`);
}

function carByComponent(ctx: PenaltyContext, name?: string): Car | undefined {
  if (!name) return undefined;
  const key = name.replace(/ /g, "");
  return [...ctx.cars.values()].find((car) => car.plate.replace(/ /g, "") === key);
}
