/** Typed calls to our own server. The session travels in an HttpOnly cookie. */
import type {
  ActionsResponse, AuditResponse, ComponentsResponse, ControlResult, CreateUserRequest, DailyReport, EventsResponse, GateAction,
  IncidentView, LoginAttemptView, MaintenanceJobView, MeResponse, PenaltiesResponse, SessionsResponse, StateSnapshot,
  StatsResponse, TimeseriesResponse, UpdateUserRequest, UsersResponse,
} from "@gpa/shared";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return p.length ? "?" + new URLSearchParams(p.map(([k, v]) => [k, String(v)])).toString() : "";
};

export const api = {
  login: (username: string, password: string) => call<MeResponse>("POST", "/api/auth/login", { username, password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => call<MeResponse>("GET", "/api/auth/me"),
  loginAttempts: (limit = 3) => call<{ items: LoginAttemptView[] }>("GET", `/api/auth/login-attempts${qs({ limit })}`),

  state: () => call<StateSnapshot>("GET", "/api/state"),
  timeseries: () => call<TimeseriesResponse>("GET", "/api/timeseries"),
  components: (q: { name?: string; limit?: number } = {}) => call<ComponentsResponse>("GET", `/api/components${qs(q)}`),
  equipment: (q: { kind?: string; zone?: string; limit?: number } = {}) =>
    call<{ items: ComponentsResponse["items"] }>("GET", `/api/equipment${qs(q)}`),
  maintenance: (limit = 100) => call<{ items: MaintenanceJobView[] }>("GET", `/api/maintenance${qs({ limit })}`),
  maintenanceStart: (kind: string, name: string) =>
    call<ControlResult>("POST", `/api/equipment/${encodeURIComponent(`${kind}:${name}`)}/maintenance`),
  incidents: (status?: string, limit = 100) => call<{ items: IncidentView[] }>("GET", `/api/incidents${qs({ status, limit })}`),
  resolveIncident: (id: number, resolution: string, status: "resolved" | "dismissed" = "resolved") =>
    call<IncidentView>("POST", `/api/incidents/${id}/resolve`, { resolution, status }),
  reconcileManualCar: (plate: string, minutes: number) =>
    call<ControlResult>("POST", `/api/control/cars/${encodeURIComponent(plate)}/reconcile`, { minutes }),
  penalties: (limit = 200) => call<PenaltiesResponse>("GET", `/api/penalties${qs({ limit })}`),
  dailyReport: (day: string, kind: "operations" | "financial" = "operations") =>
    call<DailyReport>("GET", `/api/reports/daily${qs({ day, kind })}`),
  dailyReportExportUrl: (day: string, kind: "operations" | "financial" = "operations") =>
    `/api/reports/daily/export${qs({ day, kind })}`,
  stats: (minutes: number) => call<StatsResponse>("GET", `/api/stats${qs({ minutes })}`),

  sessions: (q: { plate?: string; status?: string; since?: string; before?: number; limit?: number }) =>
    call<SessionsResponse>("GET", `/api/sessions${qs(q)}`),
  events: (q: { plate?: string; class?: string; since?: string; before?: number; limit?: number }) =>
    call<EventsResponse>("GET", `/api/events${qs(q)}`),
  actions: (q: { manual?: boolean; limit?: number }) =>
    call<ActionsResponse>("GET", `/api/actions${qs({ manual: q.manual ? 1 : undefined, limit: q.limit })}`),

  gate: (name: string, action: GateAction) => call<ControlResult>("POST", `/api/control/gates/${encodeURIComponent(name)}/${action}`),
  repairSpot: (name: string) => call<ControlResult>("POST", `/api/control/spots/${encodeURIComponent(name)}/repair`),
  entrance: (spot: string, open: boolean) =>
    call<ControlResult>("POST", `/api/control/entries/${encodeURIComponent(spot)}/${open ? "open" : "close"}`),
  resync: () => call<ControlResult>("POST", "/api/resync"),
  config: () => call<Record<string, unknown>>("GET", "/api/config"),

  users: () => call<UsersResponse>("GET", "/api/users"),
  audit: (limit = 100) => call<AuditResponse>("GET", `/api/audit${qs({ limit })}`),
  securityLoginAttempts: (limit = 100) => call<{ items: LoginAttemptView[] }>("GET", `/api/security/login-attempts${qs({ limit })}`),
  createUser: (body: CreateUserRequest) => call<MeResponse>("POST", "/api/users", body),
  updateUser: (id: number, body: UpdateUserRequest) => call<MeResponse>("PATCH", `/api/users/${id}`, body),
};
