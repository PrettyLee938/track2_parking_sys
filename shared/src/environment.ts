/**
 * Conservative normalized models for the simulator's Level 2 environment data.
 *
 * Simulator list responses are not fully specified in the checked-in contract, so a
 * missing or malformed field is represented explicitly instead of defaulting to a
 * plausible-looking value. `raw` retains the original row/payload for diagnostics.
 */

export type UnavailableReason = "missing" | "ambiguous" | "invalid";

export type Observed<T> =
  | { available: true; value: T; sourceKeys: [string] }
  | { available: false; value: null; sourceKeys: string[]; reason: UnavailableReason };

export type CollectionShape = "array" | "wrapped-array" | "single-row" | "unknown";

export interface NormalizedCollection<T> {
  rows: T[];
  /** Shape accepted by the normalizer; `unknown` means no list was safely identified. */
  shape: CollectionShape;
  /** Exact source object/array, including any wrappers. */
  raw: unknown;
  issues: string[];
}

export interface NormalizedLight {
  name: Observed<string>;
  zoneParent: Observed<string>;
  lightType: Observed<string>;
  group: Observed<string>;
  x: Observed<number>;
  y: Observed<number>;
  rotation: Observed<number>;
  scale: Observed<number>;
  intensity: Observed<number>;
  isOn: Observed<boolean>;
  colorR: Observed<number>;
  colorG: Observed<number>;
  colorB: Observed<number>;
  /** Optional API data; absent in the supplied Level 2 settings rows. */
  usageCounter: Observed<number>;
  broken: Observed<boolean>;
  isUnderMaintenance: Observed<boolean>;
  raw: unknown;
}

export interface NormalizedExhaustFan {
  name: Observed<string>;
  zoneParent: Observed<string>;
  x: Observed<number>;
  y: Observed<number>;
  rotation: Observed<number>;
  fumeIntensity: Observed<number>;
  isOn: Observed<boolean>;
  isRepairRequested: Observed<boolean>;
  repairProgress: Observed<number>;
  /** Optional API data; absent in the supplied Level 2 settings rows. */
  usageCounter: Observed<number>;
  broken: Observed<boolean>;
  isUnderMaintenance: Observed<boolean>;
  raw: unknown;
}

export interface NormalizedZone {
  name: Observed<string>;
  zoneType: Observed<string>;
  x: Observed<number>;
  y: Observed<number>;
  rotation: Observed<number>;
  width: Observed<number>;
  height: Observed<number>;
  /** If a future/actual list response supplies these exact fields, retain them. */
  carbonMonoxideLevel: Observed<number>;
  dangerLevel: Observed<string>;
  raw: unknown;
}

/** Normalized fields evidenced in `carbon_monoxide_event` webhook log rendering. */
export interface NormalizedCarbonMonoxideEvent {
  eventClass: Observed<string>;
  eventId: Observed<string>;
  sequenceId: Observed<string>;
  serverDateTime: Observed<string>;
  zoneName: Observed<string>;
  carbonMonoxideLevel: Observed<number>;
  dangerLevel: Observed<string>;
  isCarbonMonoxideEvent: boolean;
  raw: unknown;
}

/** Persisted, accepted per-zone CO facts and the current fail-safe admission state. */
export interface CoZoneSafetyState {
  zone: string;
  level: number | null;
  dangerLevel: string | null;
  source: "webhook" | "list-zones";
  sourceEventId: string | null;
  /** Server receive/check time; it is not the simulator's calendar timestamp. */
  observedAt: string;
  raw: unknown;
  restricted: boolean;
  restrictionReason: string | null;
  /** A qualifying accepted CO event has requested ventilation; cleared only by an explicit recovery check. */
  ventilationRequired: boolean;
  /** Process-local game-clock mark; it is reset on restart and never trusted from SQLite. */
  ventilationStartedAtGame: number | null;
  verifiedAt: string | null;
}
