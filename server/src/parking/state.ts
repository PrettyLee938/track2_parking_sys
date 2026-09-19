import { CarType, GateState, SpotPurpose, type CarStatus, type CarView, type GateHold } from "@gpa/shared";
import type { AllocSpot } from "../allocation";

export type Callback = () => Promise<unknown> | unknown;

export class Spot implements AllocSpot {
  broken = false;
  maintenance = false;
  /** Named occupants plus `?` for a car discovered without a matching event. */
  readonly occupants = new Set<string>();
  reserved_for: string | null = null;
  detected = 0;

  constructor(readonly name: string, public zone: string, readonly purpose: string, readonly car_type: string) {}

  get occupant(): string | null {
    for (const plate of this.occupants) if (plate !== "?") return plate;
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

export class Gate {
  state: string = GateState.Closed;
  broken = false;
  maintenance = false;
  onOpen: Callback[] = [];
  hold: GateHold = null;
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
  queue: string[];
  current: string | null;
  closed: boolean;
}

export interface ExitLane {
  spot: string;
  gate: string | null;
  zone: string;
  releasing: Set<string>;
}

export interface Car extends CarView {
  arrivedReal: number | null;
  dispatchedReal: number | null;
  parkedReal: number | null;
  leftSpotReal: number | null;
  releasedReal: number | null;
  lastSeenReal: number | null;
  dispatchRetries: number;
  chargeScheduled: boolean;
}

export function newCar(plate: string, carType: string, planned: number | null, status: CarStatus, extra: Partial<Car> = {}): Car {
  return {
    plate, car_type: carType, planned_minutes: planned, status,
    entry_lane: null, exit_lane: null, arrived_at: null, spot: null, parked_at: null, left_spot_at: null,
    exit_at: null, charge_parking: null, charge_electric: null, charge_attempts: 0, charge_override: null,
    paid: null, payment_ok: null, left_at: null,
    arrivedReal: null, dispatchedReal: null, parkedReal: null, leftSpotReal: null, releasedReal: null,
    lastSeenReal: null, dispatchRetries: 0, chargeScheduled: false,
    ...extra,
  };
}

export function publicCar(car: Car): CarView {
  const { arrivedReal, dispatchedReal, parkedReal, leftSpotReal, releasedReal, lastSeenReal, dispatchRetries, chargeScheduled, ...view } = car;
  return view;
}

export const AT_EXIT: CarStatus[] = ["at_exit", "invoiced", "payment_mismatch", "released"];
export const MID_ENTRY: CarStatus[] = ["dispatching", "dispatched"];
export const DEAD: CarStatus[] = ["turned_away", "neglected", "lost", "unknown"];

export interface Timer {
  due: number;
  label: string;
  fn: Callback;
  done: boolean;
}
