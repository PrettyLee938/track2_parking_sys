/**
 * The simulator's contract: every literal string it sends or expects, and the shape
 * of its webhook payloads and REST responses.
 *
 * Nothing else in the codebase should spell these out. If the simulator changes a
 * name, this is the only file to touch.
 */

/** ServerDateTime format, e.g. "2026-09-12 15:26:50" (wall-clock, NOT game time). */
export const SIM_TIME_FORMAT = "YYYY-MM-DD HH:mm:ss";

export const EventClass = {
  ComponentBroken: "component_broken",
  ComponentFixed: "component_fixed",
  CarbonMonoxide: "carbon_monoxide_event",
  CarSpotAction: "car_spot_action",
  GateAction: "gate_action",
  PaymentMade: "payment_made",
  Penalty: "penalty",
  Test: "test_webhook",
} as const;
export type EventClass = (typeof EventClass)[keyof typeof EventClass];

export const Direction = { In: "CarIn", Out: "CarOut" } as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const SpotPurpose = {
  Park: "Park",
  Entry: "EntrySpot",
  Exit: "ExitSpot",
  Leave: "LeaveParking",
} as const;
export type SpotPurpose = (typeof SpotPurpose)[keyof typeof SpotPurpose];

/** Also a spot's parkingForCarType ("Any" accepts every car). */
export const CarType = {
  Any: "Any",
  Normal: "Normal",
  Electric: "Electric",
  Accessible: "Accessible",
} as const;
export type CarType = (typeof CarType)[keyof typeof CarType];

export const GateState = {
  Open: "Open",
  Closed: "Closed",
  Opening: "Opening",
  Closing: "Closing",
} as const;
export type GateState = (typeof GateState)[keyof typeof GateState];

export const ComponentType = {
  BarrierGate: "BarrierGate",
  ParkingSpot: "ParkingSpot",
  ExhaustFan: "ExhaustFan",
  Light: "Light",
} as const;

/** Special goto targets (anything else is a parking spot name). */
export const Destination = {
  Exit: "exit", //         drive to any exit; payment is requested there
  LeavePark: "leavepark", // leave through an escape route
} as const;

/** Case-insensitive substrings of penalty Reason texts we react to. */
export const PenaltyReason = {
  ChargeNotAtExit: "charged at the exit",
  // "Car is being charged wrongly with amount: (2.00). Car type is (Normal) so charge should be: (4.00)"
  ChargedWrongly: "charged wrongly",
  // "Car:(ARA 545) attempted to park in an occupied spot:(S12)."
  OccupiedSpot: "occupied spot",
  // "Car has already paid for parking."
  AlreadyPaid: "already paid",
} as const;

/** Extracts the correct amount from a ChargedWrongly penalty reason. */
export const CORRECT_AMOUNT_PATTERN = /should be:\s*\(([\d.]+)\)/;

/** Extracts the spot name from an OccupiedSpot penalty reason. */
export const OCCUPIED_SPOT_PATTERN = /spot:\s*\(([^)]+)\)/i;

// ---------------------------------------------------------------------------
// Webhook payloads. Values are kept as the exact text the simulator sent (numbers
// included) so the signature can be recomputed over them.
// ---------------------------------------------------------------------------
export interface SimEventBase {
  EventClass: string;
  EventId?: string;
  SequenceId?: string;
  Signature?: string | null;
  ServerDateTime?: string;
  [field: string]: unknown;
}

export interface CarSpotActionEvent extends SimEventBase {
  CarPlateNumber: string;
  SpotName: string;
  SpotType: string;
  CarType?: string;
  Direction: string;
  PlannedParkingDurationInMinutes?: string;
}

// ---------------------------------------------------------------------------
// REST responses (/api/v1/list-*)
// ---------------------------------------------------------------------------
export interface SimParkingSpot {
  name: string;
  purpose: string;
  parkingForCarType: string;
  zoneParent: string;
  /** A count on Level 1 (the docs claim a list of plates). */
  detectedCars: number;
  broken: boolean;
  isUnderMaintenance: boolean;
}

export interface SimBarrier {
  name: string;
  zoneParent: string;
  broken: boolean;
  isUnderMaintenance: boolean;
  state: string;
}

/**
 * Lights and exhaust fans (Level 2). Their exact field spellings are not documented and
 * Level 1 has neither, so every field is optional here and `normaliseDevice` accepts the
 * spellings the simulator might plausibly use. Run `npm run probe:lvl2 -w server` against
 * a Level 2 map to see the real shape, then tighten this.
 */
export interface SimDevice {
  name?: string;
  Name?: string;
  zoneParent?: string;
  zone?: string;
  ZoneName?: string;
  broken?: boolean;
  isUnderMaintenance?: boolean;
  /** Seen as isOn / state / status depending on the endpoint. */
  isOn?: boolean;
  state?: string | boolean;
  status?: string | boolean;
  [field: string]: unknown;
}

/** True/false from a field that may be a boolean, "On"/"Off", or "true"/"false". */
export function isDeviceOn(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "on" || s === "true" || s === "running" || s === "active" || s === "1";
}

/** Pulls the fields we need out of whichever spelling the simulator used. */
export function normaliseDevice(raw: SimDevice): { name: string; zone: string; on: boolean; broken: boolean; maintenance: boolean } {
  const state = raw.isOn ?? raw.state ?? raw.status;
  return {
    name: String(raw.name ?? raw.Name ?? ""),
    zone: String(raw.zoneParent ?? raw.zone ?? raw.ZoneName ?? ""),
    on: isDeviceOn(state),
    broken: !!raw.broken,
    maintenance: !!raw.isUnderMaintenance,
  };
}

/**
 * A row from GET /list-zones: the only way to see a zone's CO *below* the Mid threshold.
 * The simulator sends carbon_monoxide_event only at Mid and above (~50), so a system that
 * listens for events alone is blind to anything quieter, and cannot act on a threshold
 * lower than Mid however it is configured.
 */
export interface SimZone {
  name?: string;
  Name?: string;
  gasCarbonMonoxideLevel?: number | string;
  CarbonMonoxideLevel?: number | string;
  risk?: string;
  DangerLevel?: string;
  [field: string]: unknown;
}

/** Pulls the fields we need out of a list-zones row, whichever spelling it used. */
export function normaliseZone(raw: SimZone): { name: string; level: number; danger: string } | null {
  const name = String(raw.name ?? raw.Name ?? "").trim();
  if (!name) return null;
  return {
    name,
    level: Number(raw.gasCarbonMonoxideLevel ?? raw.CarbonMonoxideLevel ?? 0) || 0,
    danger: String(raw.risk ?? raw.DangerLevel ?? ""),
  };
}

/** carbon_monoxide_event payload. DangerLevel is the simulator's own wording. */
export interface CarbonMonoxideEvent extends SimEventBase {
  ZoneName?: string;
  CarbonMonoxideLevel?: string | number;
  DangerLevel?: string;
}

/**
 * DangerLevel values that mean "ventilate now", whatever the numeric threshold says.
 * The simulator's levels are {Safe, Mid, High, Critical} and it only sends the event at
 * Mid and above - so "mid" already means elevated, not normal.
 */
export const CO_DANGER_WORDS = ["mid", "high", "danger", "dangerous", "critical", "severe", "warning"] as const;
