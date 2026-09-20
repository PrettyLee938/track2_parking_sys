/** Typed calls to our own server. The session travels in an HttpOnly cookie. */
import type {
  ActionsResponse, AuditResponse, ControlResult, CoZoneSafetyState, CreateUserRequest, DailyReportView, DurationReviewRequest, EventsResponse, GateAction, IncidentView,
  IncidentsResponse, LoginAttemptsResponse, LoginResponse, MeResponse, PenaltiesResponse, PenaltyDetailResponse, PenaltyResolutionStatus,
  CreateMaintenanceRequest, EquipmentResponse, MaintenanceJobsResponse, SessionsResponse, StateSnapshot, StatsResponse,
  TimeseriesResponse, UpdateUserRequest, UsersResponse, ReservationReviewRequest, VisitAdjustmentRequest, VisitExceptionRequest,
  ManualSpotOccupancyRequest, ManualSpotOccupancyClearRequest,
  SimulatorClockAnchorRequest, SimulatorClockInvalidateRequest, SimulatorClockStatus,
} from "@gpa/shared";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type RecoveryCheckResult =
  | { status: "verified"; zone: string; level: number; verified_at: string }
  | { status: "not_ready" | "unavailable" | "unsafe"; zone: string; reason: string; ventilation_started_at_game: number | null };

let onUnauthorized: () => void = () => {};
/** Called on any 401 (session expired, signed out elsewhere, account disabled). */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith("/login")) onUnauthorized();
  if (!res.ok && res.status !== 409) throw new ApiError(res.status, data.error ?? data.message ?? `HTTP ${res.status}`);
  return data as T;
}

async function callRecoveryCheck(url: string, body: { reason: string }): Promise<RecoveryCheckResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) onUnauthorized();
  // The endpoint uses 409/503 for structured not-ready, unsafe, or unavailable results.
  if (!res.ok && res.status !== 409 && res.status !== 503) {
    throw new ApiError(res.status, data.error ?? data.message ?? `HTTP ${res.status}`);
  }
  return data as RecoveryCheckResult;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return p.length ? "?" + new URLSearchParams(p.map(([k, v]) => [k, String(v)])).toString() : "";
};

export const api = {
  login: (username: string, password: string) => call<LoginResponse>("POST", "/api/auth/login", { username, password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => call<MeResponse>("GET", "/api/auth/me"),
  loginAttempts: () => call<LoginAttemptsResponse>("GET", "/api/auth/login-attempts?limit=3"),

  state: () => call<StateSnapshot>("GET", "/api/state"),
  timeseries: () => call<TimeseriesResponse>("GET", "/api/timeseries"),
  stats: (minutes: number) => call<StatsResponse>("GET", `/api/stats${qs({ minutes })}`),
  dailyReport: (day: string, kind: "operations" | "financial" | "maintenance") =>
    call<DailyReportView>("GET", `/api/reports/daily${qs({ day, kind })}`),
  penalties: (q: { day?: string; resolution_status?: PenaltyResolutionStatus; zone?: string; component?: string; vehicle?: string; reason?: string; limit?: number } = {}) =>
    call<PenaltiesResponse>("GET", `/api/penalties${qs(q)}`),
  penaltyDetail: (id: number) => call<PenaltyDetailResponse>("GET", `/api/penalties/${id}`),
  incidents: (q: { status?: "open" | "acknowledged" | "resolved"; limit?: number } = {}) =>
    call<IncidentsResponse>("GET", `/api/incidents${qs(q)}`),
  acknowledgeIncident: (id: string, reason: string) =>
    call<{ incident: IncidentView }>("POST", `/api/incidents/${encodeURIComponent(id)}/acknowledge`, { reason }),
  reviewUnknownDuration: (plate: string, body: DurationReviewRequest) =>
    call<ControlResult>("POST", `/api/visits/${encodeURIComponent(plate)}/duration-review`, body),
  reviewReservation: (visitId: string, body: ReservationReviewRequest) =>
    call<ControlResult>("POST", `/api/visits/${encodeURIComponent(visitId)}/reservation-review`, body),
  applyAdjustment: (visitId: string, body: VisitAdjustmentRequest) =>
    call<ControlResult>("POST", `/api/visits/${encodeURIComponent(visitId)}/adjustment`, body),
  waiveVisit: (visitId: string, body: VisitExceptionRequest) =>
    call<ControlResult>("POST", `/api/visits/${encodeURIComponent(visitId)}/waiver`, body),
  emergencyRelease: (visitId: string, body: VisitExceptionRequest) =>
    call<ControlResult>("POST", `/api/visits/${encodeURIComponent(visitId)}/emergency-release`, body),
  audit: (limit = 100) => call<AuditResponse>("GET", `/api/audit${qs({ limit })}`),

  sessions: (q: { plate?: string; status?: string; since?: string; before?: number; limit?: number }) =>
    call<SessionsResponse>("GET", `/api/sessions${qs(q)}`),
  events: (q: { plate?: string; class?: string; since?: string; before?: number; limit?: number }) =>
    call<EventsResponse>("GET", `/api/events${qs(q)}`),
  actions: (q: { manual?: boolean; limit?: number }) =>
    call<ActionsResponse>("GET", `/api/actions${qs({ manual: q.manual ? 1 : undefined, limit: q.limit })}`),

  gate: (name: string, action: GateAction, reason?: string) => call<ControlResult>("POST", `/api/control/gates/${encodeURIComponent(name)}/${action}`,
    action === "repair" ? { reason } : undefined),
  repairSpot: (name: string, reason: string) => call<ControlResult>("POST", `/api/control/spots/${encodeURIComponent(name)}/repair`, { reason }),
  reportManualOccupancy: (name: string, body: ManualSpotOccupancyRequest) =>
    call<ControlResult>("POST", `/api/spots/${encodeURIComponent(name)}/manual-occupancy/report`, body),
  clearManualOccupancy: (name: string, body: ManualSpotOccupancyClearRequest) =>
    call<ControlResult>("POST", `/api/spots/${encodeURIComponent(name)}/manual-occupancy/clear`, body),
  equipment: () => call<EquipmentResponse>("GET", "/api/equipment"),
  environmentZones: () => call<{ items: Omit<CoZoneSafetyState, "raw">[] }>("GET", "/api/environment/zones"),
  recoveryCheck: (zone: string, body: { reason: string }) =>
    callRecoveryCheck(`/api/environment/zones/${encodeURIComponent(zone)}/recovery-check`, body),
  maintenanceJobs: () => call<MaintenanceJobsResponse>("GET", "/api/maintenance"),
  requestMaintenance: (body: CreateMaintenanceRequest) => call<{ job: MaintenanceJobsResponse["items"][number] }>("POST", "/api/maintenance", body),
  claimMaintenance: (id: string) => call<{ job: MaintenanceJobsResponse["items"][number] }>("POST", `/api/maintenance/${encodeURIComponent(id)}/claim`),
  startMaintenance: (id: string) => call<ControlResult>("POST", `/api/maintenance/${encodeURIComponent(id)}/start`),
  entrance: (spot: string, open: boolean) =>
    call<ControlResult>("POST", `/api/control/entries/${encodeURIComponent(spot)}/${open ? "open" : "close"}`),
  resync: () => call<ControlResult>("POST", "/api/resync"),
  config: () => call<Record<string, unknown>>("GET", "/api/config"),
  simulatorClock: () => call<SimulatorClockStatus>("GET", "/api/simulator-clock"),
  anchorSimulatorClock: (body: SimulatorClockAnchorRequest) => call<SimulatorClockStatus>("POST", "/api/simulator-clock/anchor", body),
  invalidateSimulatorClock: (body: SimulatorClockInvalidateRequest) => call<SimulatorClockStatus>("POST", "/api/simulator-clock/invalidate", body),

  users: () => call<UsersResponse>("GET", "/api/users"),
  createUser: (body: CreateUserRequest) => call<MeResponse>("POST", "/api/users", body),
  updateUser: (id: number, body: UpdateUserRequest) => call<MeResponse>("PATCH", `/api/users/${id}`, body),
};
