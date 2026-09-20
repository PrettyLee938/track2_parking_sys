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
  /** The spot is withheld from allocation because its sensor is abnormal. */
  sensor_abnormal?: boolean;
  sensor_reason?: string | null;
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
  /** Ordered visits waiting for this physical exit. */
  queue?: string[];
  /** The only visit currently allowed to own the passage. */
  active?: string | null;
  /** True when the lane needs reconciliation before another passage. */
  recovery?: boolean;
}

/** A car's record. Times ending in _at are simulator ServerDateTime strings. */
export interface CarView {
  /** Stable identity for this visit; plates may be reused by the simulator. */
  visit_id?: string;
  run_id?: string | null;
  reservation_id?: string | null;
  passage_id?: string | null;
  invoice_id?: string | null;
  plate: string;
  car_type: string;
  planned_minutes: number | null;
  status: CarStatus;
  entry_lane: string | null;
  exit_lane: string | null;
  arrived_at: string | null;
  spot: string | null;
  /** The spot selected by the controller; spot is the last physically observed spot. */
  assigned_spot?: string | null;
  /** Last known physical location, including transit and exit sensors. */
  location?: string | null;
  location_confidence?: "high" | "medium" | "low" | null;
  last_location_at?: string | null;
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
  /** Why the visit is being held for operator review, when status is unknown. */
  unknown_reason?: string | null;
  /** Trusted planned/measured/operator/admin basis used for the invoice. */
  billing_basis?: string | null;
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
  /** Payment webhooks rejected as fake/invalid by the intake layer. */
  fake_payments: number;
  suspicious_payments: number;
  duplicate_requests: number;
  gate_failovers: number;
  double_parking: number;
}

/** Where the game speed figure came from (see the server's config.ts, "game clock"). */
export type TimeScaleSource = "configured" | "gate timing" | "learned" | "simulator settings" | "default";

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
  /** Every gate, parking spot, exhaust fan and light, with health and usage. */
  components: ComponentView[];
  /** Extra state from plug-in subsystems (server/src/subsystems), keyed by subsystem name. */
  subsystems: Record<string, unknown>;
  /** Level 2 environment and admission state. */
  environment?: EnvironmentSnapshot;
  /** Open incidents that need operator/admin attention. */
  incidents?: IncidentView[];
  component_summary?: ComponentSummary;
}

// ---------------------------------------------------------------------------
// components: health, usage, repairs (Level 2)
// ---------------------------------------------------------------------------
export type ComponentKind = "gate" | "spot" | "fan" | "light";
/** ok, broken (waiting for a repair), maintenance (repair under way). */
export type ComponentHealth = "ok" | "broken" | "maintenance" | "sensor_abnormal";

export interface ComponentView {
  kind: ComponentKind;
  name: string;
  zone: string;
  health: ComponentHealth;
  /** Fans and lights: switched on; gates: open; spots: occupied. null = unknown. */
  on: boolean | null;
  /** Work since the last repair: gate cycles, spot visits, fan/light on-hours (game). */
  uses: number;
  uses_total: number;
  breakdowns: number;
  /** Uses at each breakdown so far - what preventive maintenance learns the limit from. */
  uses_at_breakdown: number[];
  last_broken_at: string | null;
  last_fixed_at: string | null;
  /** Why a broken part is not being repaired yet, e.g. "a car is passing". */
  waiting: string | null;
  maintenance_due?: boolean;
}

export interface ComponentSummary {
  total: number;
  available: number;
  broken: number;
  maintenance: number;
  sensor_abnormal: number;
  by_zone: Record<string, { total: number; available: number; broken: number; maintenance: number; sensor_abnormal: number }>;
}

export type ComponentEventKind = "broken" | "fixed" | "repair_sent" | "repair_failed" | "preventive_repair";

/** GET /api/components - also written to the audit trail. */
export interface ComponentEventView {
  id: number;
  at: string;
  kind: ComponentKind;
  name: string;
  zone: string;
  event: ComponentEventKind;
  /** Fine for a breakdown, cost of a repair. */
  amount: number | null;
  detail: string | null;
}
export interface ComponentsResponse { items: ComponentView[]; events: ComponentEventView[] }

// ---------------------------------------------------------------------------
// security & audit (Level 2) - contracts; see CLAUDE.md for who builds what
// ---------------------------------------------------------------------------
/** What a role may do. The server enforces it; the dashboard uses it to hide controls. */
export type Permission =
  | "view"              // dashboard, logs, stats
  | "control"           // gates open/close/auto, entrances
  | "repair"            // start repairs on gates, spots, fans
  | "reports.financial" // revenue and financial reports
  | "users.manage"      // accounts
  | "config";           // settings, resync

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  operator: ["view", "control", "repair"],
  admin: ["view", "control", "repair", "reports.financial", "users.manage", "config"],
};

/** One sign-in attempt; the last three are shown after login. */
export interface LoginAttemptView {
  id: number;
  at: string;
  username: string;
  ok: boolean;
  ip: string | null;
  /** Why it failed: "bad password", "locked", "disabled", "unknown user". */
  reason: string | null;
}

/** An important action or change: who did what to what. actor null = the system. */
export interface AuditEntryView {
  id: number;
  at: string;
  actor: string | null;
  action: string;         // e.g. "gate.hold", "component.repair", "user.create", "webhook.rejected"
  target: string | null;  // e.g. "gate1", "user:oper"
  ok: boolean;
  detail: string | null;
}
export interface AuditResponse { items: AuditEntryView[] }

export type SecurityDecision = "accepted" | "duplicate" | "invalid_signature" | "conflict" | "malformed" | "rejected";
export interface SecurityEventView {
  id: number;
  at: string;
  ip: string | null;
  event_id: string | null;
  event_class: string | null;
  decision: SecurityDecision;
  reason: string;
  payload_hash: string | null;
}

export type IncidentStatus = "open" | "provisional" | "resolved" | "dismissed";
export interface IncidentView {
  id: number;
  at: string;
  status: IncidentStatus;
  kind: string;
  zone: string | null;
  visit_id: string | null;
  component: string | null;
  reason: string;
  confidence: "high" | "medium" | "low";
  evidence: Record<string, unknown>;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

export type MaintenanceStatus = "scheduled" | "waiting_for_clearance" | "requested" | "in_progress" |
  "completed" | "failed" | "outcome_unknown" | "cancelled";
export interface MaintenanceJobView {
  id: number;
  component_kind: ComponentKind;
  component_name: string;
  zone: string | null;
  status: MaintenanceStatus;
  reason: string;
  actor: string | null;
  created_at: string;
  updated_at: string;
  evidence: Record<string, unknown>;
}

export interface EnvironmentZoneView {
  zone: string;
  fans_on: number;
  fans: number;
  lights_on: number;
  lights: number;
  co: number | null;
  risk: string | null;
  forced: boolean;
  want: boolean;
}
export interface EnvironmentLightView {
  on: number;
  total: number;
  mode: "auto" | "always" | "never";
  detail: "route" | "group";
  night: boolean;
  hour: number | null;
  reason: string;
}
/** The snapshot emitted by the Level 2 CO/fan/light subsystem. */
export interface EnvironmentSnapshot {
  polls: number;
  lights: EnvironmentLightView;
  zones: EnvironmentZoneView[];
}

export interface VehicleLocationView {
  id: number;
  at: string;
  visit_id: string | null;
  plate: string;
  location: string;
  zone: string | null;
  assigned_spot: string | null;
  actual_spot: string | null;
  confidence: "high" | "medium" | "low";
  source: string;
  detail: string | null;
}

export interface DailyReport {
  run_id: string | null;
  day: string;
  kind: "operations" | "financial";
  time_basis: string;
  provisional: boolean;
  generated_at: string;
  totals: Record<string, number>;
  equipment: Record<string, unknown>[];
  incidents: IncidentView[];
  penalties: PenaltyView[];
  /** Level 3 evidence attached to the report so incidents remain auditable offline. */
  security_events?: SecurityEventView[];
  vehicle_locations?: VehicleLocationView[];
  maintenance?: MaintenanceJobView[];
  audit?: AuditEntryView[];
}

/** A fine from the simulator, for the penalties page. */
export interface PenaltyView {
  id: number;
  at: string;
  reason: string;
  type: string | null;
  component: string | null;
  fine: number;
}
export interface PenaltiesResponse { items: PenaltyView[] }

/** GET /api/sessions */
export interface SessionsResponse {
  items: (SessionView & { id: number; recorded_at: string })[];
}

// ---------------------------------------------------------------------------
// auth & users
// ---------------------------------------------------------------------------
/** admin can do everything an operator can, plus user management and site settings. */
export type Role = "admin" | "operator";

export interface UserView {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

/** POST /api/auth/login */
export interface LoginRequest { username: string; password: string }
/** POST /api/auth/login, GET /api/auth/me */
export interface MeResponse { user: UserView; previous_login_attempts?: LoginAttemptView[] }
/** GET /api/users */
export interface UsersResponse { items: UserView[] }
/** POST /api/users */
export interface CreateUserRequest { username: string; password: string; role: Role }
/** PATCH /api/users/:id - any subset */
export interface UpdateUserRequest { role?: Role; disabled?: boolean; password?: string }

/** Error body for every 4xx. */
export interface ApiError { error: string }

// ---------------------------------------------------------------------------
// manual control
// ---------------------------------------------------------------------------
/** POST /api/control/gates/:name/:action */
export type GateAction = "open" | "close" | "auto" | "repair";

/** Result of any control command. */
export interface ControlResult { ok: boolean; message: string }

/** GET /api/actions - commands sent to the simulator; actor null = the controller. */
export interface ActionView {
  id: number;
  at: string;
  cmd: string;
  args: string[];
  ok: boolean;
  error: string | null;
  ms: number;
  actor: string | null;
}
export interface ActionsResponse { items: ActionView[] }

// ---------------------------------------------------------------------------
// logs & statistics
// ---------------------------------------------------------------------------
/** GET /api/events - received webhooks, searchable. */
export interface EventView {
  id: number;
  received_at: string;
  event_class: string;
  plate: string | null;
  spot: string | null;
  direction: string | null;
  sig: string | null;
  accepted: boolean;
  payload: Record<string, unknown>;
}
export interface EventsResponse { items: EventView[] }

/** GET /api/timeseries - occupancy sampled by the server (in memory, recent only). */
export interface TimeseriesPoint {
  t: string;
  occupied: number;
  reserved: number;
  free: number;
  out_of_service: number;
  queued: number;
  capacity: number;
}
export interface TimeseriesResponse { sample_s: number; points: TimeseriesPoint[] }

/** GET /api/stats?minutes= - aggregates over a time window, from the database. */
export interface StatsResponse {
  since: string;
  until: string;
  bucket_s: number;
  totals: {
    arrivals: number;
    departures: number;
    turned_away: number;
    neglected: number;
    lost: number;
    revenue: number;
    avg_ticket: number;
    avg_planned_min: number;
    penalties: number;
    fines: number;
    payment_mismatches: number;
    escaped: number;
    duplicate_requests?: number;
    tampered_requests?: number;
    suspicious_payments?: number;
    double_parking?: number;
    gate_failovers?: number;
  };
  buckets: { t: string; arrivals: number; departures: number; revenue: number; turned_away: number; penalties: number }[];
  stay_histogram: { minutes: number; count: number }[];
  spot_usage: { spot: string; visits: number }[];
  penalties_by_reason: { reason: string; count: number; fines: number }[];
  gate_cycles: { gate: string; opens: number }[];
  commands: { cmd: string; count: number; failed: number; avg_ms: number; p95_ms: number }[];
}
