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
  /** Human-reported occupancy quarantine; cleared only by an explicit observed-clear action. */
  manual_occupancy: boolean;
  /** Monotonic version of manual occupancy assertions/clearance confirmations for stale-write checks. */
  manual_occupancy_version: number;
}

/** An operator's manual override on a gate; null = automatic. */
export type GateHold = "open" | "closed" | null;

export interface GateView {
  name: string;
  zone: string;
  state: string;
  broken: boolean;
  maintenance: boolean;
  /** New work is held while an active crossing drains from this gate. */
  draining: boolean;
  hold: GateHold;
}

/** Safe dashboard projection of an exhaust fan; null means the simulator did not prove it. */
export interface FanView {
  name: string;
  zone: string;
  is_on: boolean | null;
  broken: boolean | null;
  maintenance: boolean | null;
  health_known: boolean;
  usage_count: number | null;
}

/** Read-only light inventory. The simulator has no documented repair endpoint. */
export interface LightView {
  name: string;
  zone: string;
  group: string | null;
  is_on: boolean | null;
  broken: boolean | null;
  maintenance: boolean | null;
  usage_count: number | null;
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
  queue: string[];
  passage_owner: string | null;
  passage_state: "idle" | "waiting_payment" | "waiting_gate" | "opening" | "released" | "clearing" | "closing" | "uncertain";
  releasing: string[];
}

/** A car's record. Times ending in _at are simulator ServerDateTime strings. */
export interface CarView {
  visit_id?: string;
  /** Monotonic per-visit version for stale-state protection on manual actions. */
  state_version?: number;
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
  invoice_id?: string | null;
  approved_duration_minutes?: number | null;
  billing_basis?: string | null;
  invoice_status?: "none" | "pending" | "outcome_unknown" | "issued" | "settled" | "rejected" | "superseded" | "waived";
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
}

/** GET /api/sessions */
export interface SessionsResponse {
  items: (SessionView & { id: number; recorded_at: string })[];
}

// ---------------------------------------------------------------------------
// auth & users
// ---------------------------------------------------------------------------
/** Dashboard authorization roles. Permissions are checked in the Fastify API. */
export type Role = "admin" | "operator" | "maintenance";

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
export interface MeResponse { user: UserView }
/** GET /api/users */
export interface UsersResponse { items: UserView[] }
/** POST /api/users */
export interface CreateUserRequest { username: string; password: string; role: Role }
/** PATCH /api/users/:id - any subset */
export interface UpdateUserRequest { role?: Role; disabled?: boolean; password?: string }

/** GET /api/simulator-clock. This is a manual projection, never simulator-sourced time. */
export type SimulatorClockUnavailableReason =
  | "missing_anchor" | "missing_simulator_time" | "invalid_simulator_time" | "missing_real_anchor" | "invalid_real_anchor"
  | "missing_rate" | "invalid_rate" | "missing_day_start" | "invalid_day_start" | "missing_night_start"
  | "invalid_night_start" | "same_day_night_boundaries" | "missing_process_token" | "process_mismatch"
  | "manual_invalidation" | "invalid_real_time" | "calendar_time_out_of_range";
export type SimulatorClockStatus =
  | {
      status: "available"; confidence: "manual"; reason: null; run_id: string; modeled_time: string;
      simulator_epoch_ms: number; is_night: boolean; minute_of_day: number; day_start_minute: number;
      night_start_minute: number; calendar_seconds_per_real_second: number;
      source: "administrator_anchor"; anchored_at: string;
    }
  | {
      status: "unavailable"; confidence: "none"; reason: SimulatorClockUnavailableReason; run_id: string | null;
      modeled_time: null; simulator_epoch_ms: null; is_night: null; day_start_minute: null;
      night_start_minute: null; calendar_seconds_per_real_second: null; source: null; anchored_at: string | null;
    };
export interface SimulatorClockAnchorRequest {
  run_id: string;
  simulator_time_iso: string;
  calendar_seconds_per_real_second: number;
  day_start_minute: number;
  night_start_minute: number;
  reason: string;
}
export interface SimulatorClockInvalidateRequest { reason: string }

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

export type CommandIntentStatus = "pending" | "acknowledged" | "confirmed" | "rejected" | "outcome_unknown";
export interface CommandIntentView {
  id: string;
  at: string;
  updated_at: string;
  cmd: string;
  args: string[];
  actor: string | null;
  status: CommandIntentStatus;
  error: string | null;
}
export interface CommandIntentsResponse { items: CommandIntentView[] }

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
  duplicate: boolean;
  conflict: boolean;
  rejection_reason: string | null;
  payload: Record<string, unknown>;
}
export interface EventsResponse { items: EventView[] }

export interface LoginAttemptView {
  id: number;
  attempted_at: string;
  username: string;
  success: boolean;
  category: string;
  source_ip: string | null;
}
export interface LoginAttemptsResponse { items: LoginAttemptView[] }
export interface LoginResponse extends MeResponse { previous_attempts: LoginAttemptView[] }

export interface AuditView {
  id: number;
  at: string;
  actor_username: string | null;
  action: string;
  target: string | null;
  reason: string | null;
  details: Record<string, unknown>;
}
export interface AuditResponse { items: AuditView[] }

export type MaintenanceComponentType = "gate" | "spot" | "fan" | "light";
export type MaintenanceStatus = "requested" | "in_progress" | "completed" | "failed";
export interface MaintenanceJobView {
  id: string;
  component_type: MaintenanceComponentType;
  component: string;
  zone: string;
  status: MaintenanceStatus;
  requested_by: string;
  assigned_to: string | null;
  reason: string;
  requested_at: string;
  updated_at: string;
  completed_at: string | null;
  resolution: string | null;
}
export interface MaintenanceJobsResponse { items: MaintenanceJobView[] }
export interface CreateMaintenanceRequest {
  component_type: MaintenanceComponentType;
  component: string;
  reason: string;
}
export interface EquipmentResponse {
  gates: GateView[];
  spots: SpotView[];
  fans: FanView[];
  lights: LightView[];
  fan_inventory_complete: boolean;
  light_inventory_complete: boolean;
}

export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type IncidentSeverity = "info" | "warning" | "high" | "critical";
export interface IncidentView {
  id: string;
  type: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  summary: string;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
  plate: string | null;
  component: string | null;
  component_type: MaintenanceComponentType | null;
  zone: string | null;
  lane: string | null;
  reason: string | null;
  details: Record<string, unknown>;
}
export interface IncidentsResponse { items: IncidentView[] }
export interface IncidentResponse { incident: IncidentView }
export interface DurationReviewRequest { expected_version: number; minutes: number; reason: string }
export interface ReservationReviewRequest { request_id: string; expected_version: number; reason: string }

export type InvoiceStatus = "pending" | "outcome_unknown" | "issued" | "settled" | "rejected" | "superseded" | "waived";
export interface InvoiceView {
  id: string;
  visit_id: string;
  plate: string;
  revision: number;
  parking_minor: number;
  electricity_minor: number;
  total_minor: number;
  billing_basis: string;
  status: InvoiceStatus;
  created_at: string;
  updated_at: string;
  paid_minor: number | null;
}

export type FinancialAdjustmentKind = "adjustment" | "waiver" | "emergency_release";
export interface FinancialAdjustmentView {
  id: string;
  request_id: string;
  visit_id: string;
  invoice_id: string | null;
  plate: string;
  kind: FinancialAdjustmentKind;
  amount_minor: number;
  reason: string;
  actor: string;
  at: string;
}
export interface VisitAdjustmentRequest { request_id: string; expected_version: number; amount: number; reason: string }
export interface VisitExceptionRequest { request_id: string; expected_version: number; reason: string }
export interface ManualSpotOccupancyRequest {
  request_id: string;
  expected_version: number;
  observed_occupied: true;
  observation: string;
  reason: string;
}
export interface ManualSpotOccupancyClearRequest {
  request_id: string;
  expected_version: number;
  observed_clear: true;
  observation: string;
  reason: string;
}

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
  };
  buckets: { t: string; arrivals: number; departures: number; revenue: number; turned_away: number; penalties: number }[];
  stay_histogram: { minutes: number; count: number }[];
  spot_usage: { spot: string; visits: number }[];
  penalties_by_reason: { reason: string; count: number; fines: number }[];
  gate_cycles: { gate: string; opens: number }[];
  commands: { cmd: string; count: number; failed: number; avg_ms: number; p95_ms: number }[];
}

// ---------------------------------------------------------------------------
// Level 2 penalties and daily reports
// ---------------------------------------------------------------------------
export type PenaltyResolutionStatus = "unlinked" | "open" | "acknowledged" | "resolved";
/** A simulator-issued penalty, never a locally suspected incident. */
export interface PenaltyView {
  id: number;
  event_id: string | null;
  received_at: string;
  plate: string | null;
  component: string | null;
  simulator_component_type: string | null;
  zone: string | null;
  message: string | null;
  fine_amount_raw: string | null;
  /** FineAmount interpreted as major currency units and converted to minor units; null if unparseable. */
  fine_minor: number | null;
  incident_id: string | null;
  resolution_status: PenaltyResolutionStatus;
  run_id: string | null;
}
/** GET /api/penalties. The received-time filter is provisional until simulator time/run is identified. */
export interface PenaltiesResponse {
  items: PenaltyView[];
  time_basis: "server_utc_received_at_provisional";
  simulator_day: null;
  simulator_run_id: null;
  provisional: true;
}

export interface PenaltyEvidenceEvent {
  id: number;
  event_id: string | null;
  received_at: string;
  event_class: string;
  plate: string | null;
  spot: string | null;
  direction: string | null;
}
export interface PenaltyEvidenceCommand {
  id: string;
  source: "action" | "command_intent";
  at: string;
  cmd: string;
  args: string[];
  actor: string | null;
  outcome: string;
}
export interface PenaltyRelatedVisit {
  visit_id: string;
  plate: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  spot: string | null;
  entry_lane: string | null;
  exit_lane: string | null;
}
export interface PenaltyLinkedIncident {
  id: string;
  type: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  summary: string;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
  component: string | null;
  component_type: string | null;
  zone: string | null;
  latest_note: string | null;
}
/** GET /api/penalties/:id. Evidence is contextual and never represents a causal diagnosis. */
export interface PenaltyDetailView {
  penalty: PenaltyView;
  related_visit: PenaltyRelatedVisit | null;
  visit_link: "linked" | "ambiguous" | "none";
  related_component: { name: string; simulator_type: string | null; zone: string | null } | null;
  nearby_events: PenaltyEvidenceEvent[];
  nearby_commands: PenaltyEvidenceCommand[];
  suspected_cause: { assessment: "undetermined"; confidence: "unknown"; explanation: string };
  recovery_action: { status: "unverified"; explanation: string };
  linked_incident: PenaltyLinkedIncident | null;
}
export interface PenaltyDetailResponse { item: PenaltyDetailView }

export interface DailyReportOperational {
  arrivals: number;
  admissions: number;
  completed_departures: number;
  turnaways: number;
  abandoned_visits: number;
  lost_visits: number;
  accepted_simulator_penalties: number;
  component_failure_events: number;
  component_recovery_events: number;
  co_events: number;
  peak_co_level: number | null;
}

/** A Maintenance user's deliberately limited, equipment-only daily view. */
export interface MaintenanceDailyReport {
  maintenance_requests: number;
  completed_repairs_current_status: number;
  active_jobs_current_status: number;
  failed_jobs_current_status: number;
  open_equipment_incidents_current_status: number;
  component_failure_events: number;
  component_recovery_events: number;
  co_events: number;
  peak_co_level: number | null;
}

export interface DailyReportFinancial {
  /** Invoices created during this UTC day, regardless of later status. */
  invoices_created: number;
  /** Created during this day and currently in issued or settled status. */
  invoices_issued_current_status: number;
  /** Accepted payment events matched by EventId to a currently settled invoice, attributed to event-received day. */
  verified_payments_count: number;
  verified_payments_minor: number;
  /** Current unpaid invoice states including pending, issued, and outcome_unknown. */
  outstanding_invoices_current_status: number;
  uncertain_payment_outcomes_current_status: number;
  waived_invoices_current_status: number;
  waived_total_minor_current_status: number;
  financial_adjustments_count: number;
  financial_adjustments_amount_minor_recorded: number;
  waiver_records_count: number;
  waiver_amount_minor_recorded: number;
  emergency_release_records_count: number;
  emergency_release_amount_minor_recorded: number;
  known_simulator_fines_minor: number;
  unknown_simulator_fine_amount_count: number;
  /** Verified payments less known simulator fines only; not profit or net operating income. */
  receipts_after_known_simulator_fines_minor: number | null;
  financial_state_as_of: string;
}

/** Shared report metadata. `day` means server UTC date, not simulator calendar day. */
interface DailyReportBase {
  requested_utc_day: string;
  period_start_utc: string;
  period_end_utc_exclusive: string;
  generated_at: string;
  time_basis: "server_utc_persisted_timestamps_provisional";
  simulator_calendar_status: "unavailable";
  simulator_day: null;
  simulator_run_id: null;
  provisional: true;
  unavailable_metrics: string[];
}

/** GET /api/reports/daily for Operator/Admin. */
export interface DailyReportResponse extends DailyReportBase {
  operational: DailyReportOperational;
  /** Absent for non-admin callers; never represented as zero for them. */
  financial?: DailyReportFinancial;
}

/** Maintenance receives equipment-only daily aggregates, never traffic or financial fields. */
export interface MaintenanceDailyReportResponse extends DailyReportBase {
  maintenance: MaintenanceDailyReport;
  operational?: never;
  financial?: never;
}

export type DailyReportView = DailyReportResponse | MaintenanceDailyReportResponse;
