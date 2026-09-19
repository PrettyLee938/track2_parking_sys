/**
 * Our own HTTP API: the contract between server and dashboard. Both sides compile
 * against these types, so a renamed field is a build error, not a blank widget.
 */

export type CarStatus =
  | "queued" | "dispatching" | "dispatched" | "entering" | "parked" | "to_exit"
  | "at_exit" | "invoiced" | "payment_mismatch" | "released"
  | "turned_away" | "neglected" | "lost" | "unknown" | "gone";

export type FeedLevel = "info" | "warn" | "error";

export interface FeedItem {
  at: string;
  level: FeedLevel;
  msg: string;
}

export interface ZoneSummary {
  total: number;
  occupied: number;
  reserved: number;
  free: number;
  out_of_service: number;
}

export interface SpotView {
  name: string;
  zone: string;
  purpose: string;
  car_type: string;
  broken: boolean;
  maintenance: boolean;
  occupant: string | null;
  /** Everyone physically in the spot - more than one only when a car was parked on top of another. */
  occupants: string[];
  reserved_for: string | null;
  detected: number;
  available: boolean;
}

/** An operator's manual override on a gate; null = automatic. */
export type GateHold = "open" | "closed" | null;

export interface GateView {
  name: string;
  zone: string;
  state: string;
  broken: boolean;
  maintenance: boolean;
  hold: GateHold;
}

export interface EntryLaneView {
  spot: string;
  gate: string | null;
  zone: string;
  queue: string[];
  current: string | null;
  /** Closed by an admin: arriving cars are turned away. */
  closed: boolean;
}

export interface ExitLaneView {
  spot: string;
  gate: string | null;
  zone: string;
  releasing: string[];
}

/** A car's record. Times ending in _at are simulator ServerDateTime strings. */
export interface CarView {
  plate: string;
  car_type: string;
  planned_minutes: number | null;
  status: CarStatus;
  entry_lane: string | null;
  exit_lane: string | null;
  arrived_at: string | null;
  spot: string | null;
  parked_at: string | null;
  left_spot_at: string | null;
  exit_at: string | null;
  charge_parking: number | null;
  charge_electric: number | null;
  charge_attempts: number;
  charge_override: number | null;
  paid: number | null;
  payment_ok: boolean | null;
  left_at: string | null;
}

export interface SessionView extends CarView {
  parked_seconds: number | null;
}

export interface Counters {
  arrived: number;
  admitted: number;
  turned_away: number;
  neglected: number;
  exited: number;
  revenue: number;
  payment_mismatches: number;
  repeat_exits: number;
  /** Car records retired because their closing event never arrived (lost webhook / restart). */
  ghosts_retired: number;
  escaped: number;
  penalties: number;
  fines: number;
  command_errors: number;
}

/** Where the game speed figure came from (see the server's config.ts, "game clock"). */
export type TimeScaleSource = "configured" | "learned" | "simulator settings" | "default";

/** GET /api/state */
export interface StateSnapshot {
  synced: boolean;
  /** Game seconds per real second, i.e. the simulator's game speed. */
  time_scale: number;
  time_scale_source: TimeScaleSource;
  topology: { name: string; source: string } | null;
  zones: Record<string, ZoneSummary>;
  spots: SpotView[];
  gates: GateView[];
  entry_lanes: EntryLaneView[];
  exit_lanes: ExitLaneView[];
  active_cars: CarView[];
  recent_sessions: SessionView[];
  counters: Counters;
  feed: FeedItem[];
}

/** GET /api/sessions */
export interface SessionsResponse {
  items: (SessionView & { id: number; recorded_at: string })[];
}
