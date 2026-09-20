/**
 * HTTP routes.
 *
 * Public:     POST /webhook (the simulator), POST /api/auth/login, the built dashboard
 * Operator+:  live state & stream, statistics, logs, and manual control of gates and spots
 * Admin only: users, entrance open/close, resync, effective configuration
 * Debug:      /debug/* from this machine only (the tools), or for an admin
 *
 * Every rule is enforced here on the server; the dashboard hides what a role cannot do,
 * but never relies on that.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ActionsResponse, ApiError, AuditResponse, CommandIntentsResponse, ControlResult, CreateUserRequest, DailyReportResponse, DailyReportView,
  EventsResponse, GateAction, LoginAttemptsResponse, DurationReviewRequest, EquipmentResponse, IncidentResponse, IncidentsResponse,
  LoginRequest, LoginResponse, MaintenanceJobsResponse, MeResponse, PenaltiesResponse, PenaltyDetailResponse, PenaltyResolutionStatus, Role,
  SessionsResponse, StateSnapshot, StatsResponse, TimeseriesResponse, UpdateUserRequest, UserView, UsersResponse,
  SimulatorClockAnchorRequest, SimulatorClockInvalidateRequest,
  VisitAdjustmentRequest, VisitExceptionRequest, ReservationReviewRequest,
  ManualSpotOccupancyRequest, ManualSpotOccupancyClearRequest,
} from "@gpa/shared";
import { AuthService, hashPassword, hasRole, validateCredentials } from "./auth";
import { REPO_ROOT, type Settings } from "./config";
import type { Controller } from "./controller";
import { SimulatorCalendar } from "./simulatorCalendar";
import type { EventRecord, Store } from "./store";
import { Intake, parseRaw } from "./webhook";

declare module "fastify" {
  interface FastifyRequest {
    user: UserView | null;
  }
}

export interface AppDeps {
  cfg: Settings;
  controller: Controller;
  store: Store;
  auth: AuthService;
  intake?: Intake;
}

export const SESSION_COOKIE = "gpa_session";
const GATE_ACTIONS: GateAction[] = ["open", "close", "auto", "repair"];
const BUCKETS_S = [60, 120, 300, 600, 900, 1800, 3600];

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeS: number) {
  reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeS)}`);
}

const err = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error } satisfies ApiError);

/** JSON request bodies arrive as text (the webhook needs the raw text), so parse here. */
function jsonBody<T>(req: FastifyRequest): T | null {
  try {
    const parsed = JSON.parse(String(req.body ?? "") || "{}");
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

function utcDayWindow(day: string | undefined): { startMs: number; endMs: number } | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== day) return null;
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  // Prefix formula-like user-supplied cells so opening the export in spreadsheet software is inert.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Keep Maintenance useful without disclosing plate, visit, payment, or penalty data. */
function maintenanceSnapshot(source: StateSnapshot): StateSnapshot {
  return {
    ...source,
    spots: source.spots.map((s) => ({ ...s, occupant: s.occupant ? "occupied" : null, occupants: [], reserved_for: s.reserved_for ? "reserved" : null })),
    entry_lanes: source.entry_lanes.map((l) => ({ ...l, queue: [], current: null })),
    exit_lanes: source.exit_lanes.map((l) => ({ ...l, queue: [], passage_owner: null, releasing: [] })),
    active_cars: [],
    recent_sessions: [],
    counters: { ...source.counters, revenue: 0, penalties: 0, fines: 0, escaped: 0 },
    feed: [],
  };
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { cfg, controller, store, auth } = deps;
  const strictSignatures = cfg.webhookProfile === "level2" || cfg.requireSignature;
  const intake = deps.intake ?? new Intake(strictSignatures);
  intake.restoreSequence(store.lastWebhookSequence(cfg.webhookProfile));
  const recent: EventRecord[] = [];

  // Fastify logs every request at info level; one line per webhook is noise.
  app.addHook("onRoute", (route) => {
    route.logLevel = "warn";
  });

  // The webhook needs the raw body: Fastify's JSON parser would turn 1.0 into 1 before
  // the signature is checked. Accept any content type the simulator might send.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  // Who is calling: resolved from the session cookie on every request.
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = auth.userForToken(cookies(req)[SESSION_COOKIE]);
  });

  const guard = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return err(reply, 401, "not signed in");
    if (!hasRole(req.user, role)) return err(reply, 403, `requires the ${role} role`);
  };
  const operator = { preHandler: guard("operator") };
  const maintenance = { preHandler: guard("maintenance") };
  const admin = { preHandler: guard("admin") };
  const authenticated = { preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return err(reply, 401, "not signed in");
  } };
  const operationalRead = { preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return err(reply, 401, "not signed in");
    if (!hasRole(req.user, "operator") && !hasRole(req.user, "maintenance")) return err(reply, 403, "requires an operational role");
  } };
  const stateFor = (user: UserView) => user.role === "maintenance" ? maintenanceSnapshot(controller.snapshot()) : controller.snapshot();
  const debugAccess = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isLoopback(req.ip) && !hasRole(req.user, "admin")) return err(reply, 403, "debug endpoints: this machine or an admin only");
    },
  };

  // ---------------------------------------------------------------------------
  // simulator -> us
  // ---------------------------------------------------------------------------
  app.post("/webhook", async (req, reply) => {
    const receivedAt = new Date().toISOString();
    const rawBody = String(req.body ?? "");
    if (cfg.webhookLoopbackOnly && !isLoopback(req.ip)) {
      req.log.warn({ ip: req.ip }, "rejected webhook from non-loopback address");
      return err(reply, 403, "webhook ingress is restricted to loopback");
    }
    let event;
    try {
      event = parseRaw(rawBody);
    } catch {
      try {
        store.recordMalformedWebhook(receivedAt, rawBody, cfg.webhookProfile);
      } catch (cause) {
        req.log.error({ err: cause }, "could not persist malformed webhook delivery");
        return err(reply, 503, "webhook persistence unavailable");
      }
      intake.recordMalformed();
      req.log.error({ body: rawBody.slice(0, 300) }, "malformed webhook");
      return err(reply, 400, "malformed JSON payload");
    }

    const assessment = intake.assess(event);
    const rejectionReason = assessment.sig === "unsigned" ? "signature required" :
      assessment.sig === "invalid" ? "invalid signature" : null;
    let meta;
    try {
      meta = store.persistWebhook(event, {
        receivedAt, rawBody, sig: assessment.sig, trusted: assessment.trusted,
        profile: cfg.webhookProfile, rejectionReason,
      });
    } catch (cause) {
      req.log.error({ err: cause }, "could not persist webhook delivery");
      return err(reply, 503, "webhook persistence unavailable");
    }
    intake.recordPersisted(assessment.sig, meta);

    const record: EventRecord = {
      ...event, _received_at: receivedAt, _sig: assessment.sig, _duplicate: meta.duplicate,
      _conflict: meta.conflict, _seq_note: meta.seqNote, _accepted: meta.accept,
      _profile: cfg.webhookProfile,
    };
    recent.push(record);
    if (recent.length > cfg.recentEventsSize) recent.shift();

    if (meta.seqNote) req.log.warn(`sequence gap: ${meta.seqNote}`);
    if (meta.conflict) {
      req.log.error({ eventId: event.EventId, payloadHash: "stored" }, "event ID reused with a different payload");
      return err(reply, 409, "event ID conflict");
    }
    if (meta.duplicate) {
      req.log.info({ eventId: event.EventId }, "ignored exact duplicate webhook");
      return { ok: true };
    }
    if (!assessment.trusted) {
      req.log.warn(`dropped ${event.EventClass} (signature ${assessment.sig})`);
      return err(reply, 401, rejectionReason ?? "untrusted webhook signature");
    }
    if (meta.accept && cfg.controllerEnabled) {
      controller.submit(record); // handled on the controller's queue; respond immediately
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // authentication
  // ---------------------------------------------------------------------------
  app.post("/api/auth/login", async (req, reply) => {
    const body = jsonBody<LoginRequest>(req);
    if (!body?.username || !body?.password) return err(reply, 400, "username and password are required");
    const result = await auth.login(String(body.username), String(body.password), {
      sourceIp: req.ip, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    });
    if (!result.ok) {
      if (result.reason === "throttled") {
        reply.header("retry-after", String(result.retryAfterS));
        return err(reply, 429, `too many failed attempts - try again in ${result.retryAfterS}s`);
      }
      return err(reply, 401, "wrong username or password");
    }
    setSessionCookie(reply, result.token, cfg.sessionTtlH * 3600);
    req.log.warn(`sign-in: ${result.user.username} (${result.user.role})`);
    return { user: result.user, previous_attempts: result.previousAttempts } satisfies LoginResponse;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(cookies(req)[SESSION_COOKIE]);
    setSessionCookie(reply, "", 0);
    return { ok: true };
  });

  app.get("/api/auth/me", authenticated, async (req): Promise<MeResponse> => ({ user: req.user! }));

  app.get<{ Querystring: { limit?: string } }>("/api/auth/login-attempts", authenticated, async (req): Promise<LoginAttemptsResponse> => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 3, 3));
    return { items: auth.loginAttemptsForToken(cookies(req)[SESSION_COOKIE], limit) };
  });

  // ---------------------------------------------------------------------------
  // live state (operator+)
  // ---------------------------------------------------------------------------
  app.get("/api/state", operationalRead, async (req): Promise<StateSnapshot> => stateFor(req.user!));

  /** Server-sent events: a snapshot every streamIntervalS, until the session ends. */
  app.get("/api/stream", operationalRead, (req, reply) => {
    const token = cookies(req)[SESSION_COOKIE];
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = () => {
      const user = auth.userForToken(token);
      if (user) res.write(`data: ${JSON.stringify(stateFor(user))}\n\n`);
    };
    send();
    const timer = setInterval(() => {
      if (!auth.userForToken(token)) { // signed out, expired or disabled meanwhile
        res.write("event: signedout\ndata: {}\n\n");
        clearInterval(timer);
        res.end();
        return;
      }
      send();
    }, cfg.streamIntervalS * 1000);
    req.raw.on("close", () => clearInterval(timer));
  });

  app.get("/api/timeseries", operationalRead, async (): Promise<TimeseriesResponse> =>
    ({ sample_s: cfg.statsSampleS, points: controller.timeseries }));

  app.get<{ Querystring: { minutes?: string } }>("/api/stats", operator, async (req): Promise<StatsResponse> => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 7 * 24 * 60);
    const bucket = BUCKETS_S.find((b) => (minutes * 60) / b <= 40) ?? BUCKETS_S.at(-1)!;
    const until = Date.now();
    const result = store.stats(until - minutes * 60_000, until, bucket);
    if (req.user!.role !== "admin") {
      // Existing operational chart contract has financial fields; redact them server-side.
      result.totals.revenue = 0;
      result.totals.avg_ticket = 0;
      result.totals.fines = 0;
      result.buckets = result.buckets.map((b) => ({ ...b, revenue: 0 }));
      result.penalties_by_reason = result.penalties_by_reason.map((p) => ({ ...p, fines: 0 }));
    }
    return result;
  });

  type DailyQuery = { day?: string; date?: string; run_id?: string; kind?: string };
  const dailyReport = (day: string, includeFinancial: boolean): DailyReportResponse => {
    const window = utcDayWindow(day)!;
    const generatedAt = new Date().toISOString();
    const facts = store.dailyReportFacts(window.startMs, window.endMs, generatedAt);
    return {
      requested_utc_day: day,
      period_start_utc: new Date(window.startMs).toISOString(),
      period_end_utc_exclusive: new Date(window.endMs).toISOString(),
      generated_at: generatedAt,
      time_basis: "server_utc_persisted_timestamps_provisional",
      simulator_calendar_status: "unavailable",
      simulator_day: null,
      simulator_run_id: null,
      provisional: true,
      operational: facts.operational,
      ...(includeFinancial ? { financial: facts.financial } : {}),
      unavailable_metrics: facts.unavailableMetrics,
    };
  };
  const maintenanceDailyReport = (day: string): DailyReportView => {
    const window = utcDayWindow(day)!;
    const generatedAt = new Date().toISOString();
    const facts = store.dailyReportFacts(window.startMs, window.endMs, generatedAt);
    const jobs = store.listMaintenanceJobs(1000);
    const inDay = (value: string | null) => {
      if (!value) return false;
      const t = Date.parse(value);
      return Number.isFinite(t) && t >= window.startMs && t < window.endMs;
    };
    return {
      requested_utc_day: day,
      period_start_utc: new Date(window.startMs).toISOString(),
      period_end_utc_exclusive: new Date(window.endMs).toISOString(),
      generated_at: generatedAt,
      time_basis: "server_utc_persisted_timestamps_provisional",
      simulator_calendar_status: "unavailable",
      simulator_day: null,
      simulator_run_id: null,
      provisional: true,
      maintenance: {
        maintenance_requests: jobs.filter((job) => inDay(job.requested_at)).length,
        completed_repairs_current_status: jobs.filter((job) => job.status === "completed").length,
        active_jobs_current_status: jobs.filter((job) => job.status === "requested" || job.status === "in_progress").length,
        failed_jobs_current_status: jobs.filter((job) => job.status === "failed").length,
        open_equipment_incidents_current_status: store.listIncidents({ equipmentOnly: true, status: "open", limit: 1000 }).length,
        component_failure_events: facts.operational.component_failure_events,
        component_recovery_events: facts.operational.component_recovery_events,
        co_events: facts.operational.co_events,
        peak_co_level: facts.operational.peak_co_level,
      },
      unavailable_metrics: [
        "Simulator calendar day and run identity (manual clock anchor is not configured).",
        "Equipment runtime, downtime, repair duration, and historical job status transitions (interval history is unavailable).",
        "Peak CO reading and ventilation runtime (the event contract does not provide a verified numeric reading/runtime basis).",
      ],
    };
  };
  const reportOptions = (req: FastifyRequest<{ Querystring: DailyQuery }>, reply: FastifyReply) => {
    if (req.query.day && req.query.date && req.query.day !== req.query.date) return { error: err(reply, 400, "day and date must match when both are supplied") };
    if (req.query.run_id) return { error: err(reply, 409, "simulator run identity is unavailable; this report can only use provisional server-UTC timestamps") };
    if (req.query.kind && req.query.kind !== "operations" && req.query.kind !== "financial" && req.query.kind !== "maintenance") {
      return { error: err(reply, 400, "kind must be operations, financial, or maintenance") };
    }
    if (req.query.kind === "financial" && req.user!.role !== "admin") {
      return { error: err(reply, 403, "financial reports require Admin") };
    }
    if (req.user!.role === "maintenance" && req.query.kind && req.query.kind !== "maintenance") {
      return { error: err(reply, 403, "Maintenance can view equipment-only reports") };
    }
    if (req.query.kind === "maintenance" && req.user!.role === "operator") {
      return { error: err(reply, 403, "equipment-only reports require Maintenance or Admin") };
    }
    const day = req.query.date ?? req.query.day;
    const window = utcDayWindow(day);
    if (!window) return { error: err(reply, 400, "day must be a valid YYYY-MM-DD server UTC date; no simulator-calendar default is available") };
    const includeFinancial = req.user!.role === "admin" && req.query.kind !== "operations";
    const maintenanceOnly = req.user!.role === "maintenance" || req.query.kind === "maintenance";
    return { day: day!, includeFinancial: includeFinancial && !maintenanceOnly, maintenanceOnly };
  };

  app.get<{ Querystring: DailyQuery }>("/api/reports/daily", operationalRead, async (req, reply) => {
    const options = reportOptions(req, reply);
    if ("error" in options) return options.error;
    return options.maintenanceOnly ? maintenanceDailyReport(options.day) : dailyReport(options.day, options.includeFinancial);
  });

  app.get<{ Querystring: DailyQuery }>("/api/reports/daily/export", operationalRead, async (req, reply) => {
    const options = reportOptions(req, reply);
    if ("error" in options) return options.error;
    const report = options.maintenanceOnly ? maintenanceDailyReport(options.day) : dailyReport(options.day, options.includeFinancial);
    const rows: [string, string, unknown][] = [
      ["report", "requested_utc_day", report.requested_utc_day],
      ["report", "period_start_utc", report.period_start_utc],
      ["report", "period_end_utc_exclusive", report.period_end_utc_exclusive],
      ["report", "generated_at", report.generated_at],
      ["report", "time_basis", report.time_basis],
      ["report", "simulator_calendar_status", report.simulator_calendar_status],
      ["report", "simulator_day", report.simulator_day],
      ["report", "simulator_run_id", report.simulator_run_id],
      ["report", "provisional", report.provisional],
      ...("maintenance" in report ? Object.entries(report.maintenance).map(([metric, value]): [string, string, unknown] => ["maintenance", metric, value]) :
        Object.entries(report.operational).map(([metric, value]): [string, string, unknown] => ["operational", metric, value])),
      ...( "financial" in report && report.financial ? Object.entries(report.financial).map(([metric, value]): [string, string, unknown] => ["financial", metric, value]) : []),
      ...report.unavailable_metrics.map((value, index): [string, string, unknown] => ["unavailable", `metric_${index + 1}`, value]),
    ];
    const csv = [["section", "metric", "value"], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "report.daily.export", target: options.day,
      details: { kind: req.query.kind ?? "default", financial_included: !!report.financial,
        time_basis: report.time_basis, simulator_calendar_status: report.simulator_calendar_status, simulator_run_id: null,
        maintenance_only: "maintenance" in report } });
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="daily-report-${options.day}.csv"`).send(csv);
  });

  // ---------------------------------------------------------------------------
  // logs (operator+)
  // ---------------------------------------------------------------------------
  type ListQuery = { plate?: string; status?: string; class?: string; since?: string; until?: string; limit?: string; before?: string };
  const num = (v?: string) => (v ? Number(v) || undefined : undefined);

  type PenaltyQuery = { day?: string; since?: string; until?: string; run_id?: string; zone?: string; component?: string;
    vehicle?: string; reason?: string; resolution_status?: string; limit?: string };
  app.get<{ Querystring: PenaltyQuery }>("/api/penalties", operator, async (req, reply): Promise<PenaltiesResponse | ApiError> => {
    if (req.query.run_id) return err(reply, 409, "simulator run identity is unavailable; penalty filtering by run is not supported");
    let sinceMs: number | undefined, untilMsExclusive: number | undefined;
    if (req.query.day && (req.query.since || req.query.until)) return err(reply, 400, "use day or since/until, not both");
    if (req.query.day) {
      const window = utcDayWindow(req.query.day);
      if (!window) return err(reply, 400, "day must be a valid YYYY-MM-DD server UTC date");
      sinceMs = window.startMs; untilMsExclusive = window.endMs;
    } else {
      if (req.query.since) {
        sinceMs = Date.parse(req.query.since);
        if (!Number.isFinite(sinceMs)) return err(reply, 400, "since must be a valid timestamp");
      }
      if (req.query.until) {
        const untilMs = Date.parse(req.query.until);
        if (!Number.isFinite(untilMs)) return err(reply, 400, "until must be a valid timestamp");
        untilMsExclusive = untilMs + 1;
      }
      if (sinceMs !== undefined && untilMsExclusive !== undefined && sinceMs >= untilMsExclusive) return err(reply, 400, "since must not be after until");
    }
    const validResolution: PenaltyResolutionStatus[] = ["unlinked", "open", "acknowledged", "resolved"];
    if (req.query.resolution_status && !validResolution.includes(req.query.resolution_status as PenaltyResolutionStatus)) {
      return err(reply, 400, `resolution_status must be one of ${validResolution.join(", ")}`);
    }
    let items = store.searchAcceptedPenalties({ sinceMs, untilMsExclusive, plate: req.query.vehicle, component: req.query.component,
      zone: req.query.zone, reason: req.query.reason, resolutionStatus: req.query.resolution_status as PenaltyResolutionStatus | undefined,
      limit: num(req.query.limit) ?? 100 });
    if (req.user!.role !== "admin") items = items.map((item) => ({ ...item, fine_minor: null, fine_amount_raw: null }));
    return { items, time_basis: "server_utc_received_at_provisional", simulator_day: null, simulator_run_id: null, provisional: true };
  });

  app.get<{ Params: { id: string } }>("/api/penalties/:id", operator, async (req, reply): Promise<PenaltyDetailResponse | ApiError> => {
    if (!/^[1-9]\d*$/.test(req.params.id)) return err(reply, 404, "penalty not found");
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return err(reply, 404, "penalty not found");
    const item = store.acceptedPenaltyDetail(id);
    // Return the same not-found result for rejected, duplicate, conflicting, and nonexistent rows.
    if (!item) return err(reply, 404, "penalty not found");
    if (req.user!.role !== "admin") item.penalty = { ...item.penalty, fine_minor: null, fine_amount_raw: null };
    return { item };
  });

  app.get<{ Querystring: ListQuery }>("/api/sessions", operator, async (req): Promise<SessionsResponse> => ({
    items: store.searchSessions({ plate: req.query.plate, status: req.query.status, since: req.query.since,
      until: req.query.until, limit: num(req.query.limit), beforeId: num(req.query.before) }),
  }));

  app.get<{ Querystring: ListQuery }>("/api/events", operator, async (req): Promise<EventsResponse> => ({
    items: store.searchEvents({ plate: req.query.plate, eventClass: req.query.class, since: req.query.since,
      until: req.query.until, limit: num(req.query.limit), beforeId: num(req.query.before) }),
  }));

  app.get<{ Querystring: { manual?: string; limit?: string } }>("/api/actions", operator, async (req): Promise<ActionsResponse> => ({
    items: store.searchActions({ manualOnly: req.query.manual === "1", limit: num(req.query.limit) }),
  }));

  app.get<{ Querystring: { limit?: string } }>("/api/commands", operator, async (req): Promise<CommandIntentsResponse> => ({
    items: store.listCommandIntents(Number(req.query.limit) || 100),
  }));

  app.get("/api/equipment", operationalRead, async (req): Promise<EquipmentResponse> => {
    const state = stateFor(req.user!);
    return { gates: state.gates, spots: state.spots, fans: controller.fanSnapshot(), lights: controller.lightSnapshot(),
      ...controller.equipmentInventoryStatus() };
  });

  app.get("/api/environment/zones", operationalRead, async () => ({ items: controller.coSafetySnapshot() }));

  app.post<{ Params: { zone: string } }>("/api/environment/zones/:zone/recovery-check", operator, async (req, reply) => {
    const body = jsonBody<{ reason?: string }>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (!body.reason || body.reason.trim().length < 8) return err(reply, 400, "a reason of at least 8 characters is required");
    const result = await controller.exclusive(() => controller.verifyCoRecovery(req.params.zone, req.user!.username));
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "environment.co_recovery_check",
      target: req.params.zone, reason: body.reason.trim(), details: result });
    const status = result.status === "verified" ? 200 : result.status === "unavailable" ? 503 : 409;
    return reply.code(status).send(result);
  });

  app.get<{ Querystring: { limit?: string } }>("/api/maintenance", operationalRead, async (req): Promise<MaintenanceJobsResponse> => ({
    items: store.listMaintenanceJobs(Number(req.query.limit) || 100, req.user!.role === "maintenance" ? req.user!.username : undefined),
  }));

  // Operators may request work; Maintenance/Admin start it only through safety checks.
  app.post("/api/maintenance", operationalRead, async (req, reply) => {
    const body = jsonBody<{ component_type?: string; component?: string; reason?: string }>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.component_type === "light") return err(reply, 400, "light repair is not supported by the simulator API");
    if (body.component_type !== "gate" && body.component_type !== "spot" && body.component_type !== "fan") {
      return err(reply, 400, "component_type must be gate, spot, or fan");
    }
    if (!body.component || !body.reason || body.reason.trim().length < 8) return err(reply, 400, "component and a reason of at least 8 characters are required");
    const state = controller.snapshot();
    const target = body.component_type === "gate" ? state.gates.find((g) => g.name === body.component) :
      body.component_type === "spot" ? state.spots.find((s) => s.name === body.component && s.purpose === "Park") :
        controller.fanSnapshot().find((fan) => fan.name === body.component);
    if (!target) return err(reply, 404, "component is not in the loaded simulator level");
    if (store.activeMaintenanceJob(body.component_type, body.component)) return err(reply, 409, "an active job already exists for this component");
    const job = store.createMaintenanceJob({ componentType: body.component_type, component: body.component,
      zone: target.zone, requestedBy: req.user!.username,
      assignedTo: req.user!.role === "maintenance" ? req.user!.username : null, reason: body.reason });
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "maintenance.requested",
      target: job.component, reason: job.reason, details: { job_id: job.id, component_type: job.component_type } });
    return reply.code(201).send({ job });
  });

  app.post<{ Params: { id: string } }>("/api/maintenance/:id/claim", maintenance, async (req, reply) => {
    const job = store.getMaintenanceJob(req.params.id);
    if (!job) return err(reply, 404, "no such maintenance request");
    if (job.status !== "requested") return err(reply, 409, "only an unstarted maintenance request can be claimed");
    const claimed = store.assignMaintenanceJob(job.id, req.user!.username);
    if (!claimed) return err(reply, 409, "maintenance request is already assigned to another technician");
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "maintenance.claimed",
      target: job.component, reason: job.reason, details: { job_id: job.id, component_type: job.component_type } });
    return { job: claimed };
  });

  app.post<{ Params: { id: string } }>("/api/maintenance/:id/start", maintenance, async (req, reply) => {
    const job = store.getMaintenanceJob(req.params.id);
    if (!job) return err(reply, 404, "no such maintenance request");
    if (job.status !== "requested") return err(reply, 409, "maintenance request is not awaiting start");
    if (req.user!.role === "maintenance" && job.assigned_to !== req.user!.username) {
      return err(reply, 403, "claim this maintenance request before starting it");
    }
    if (!job.assigned_to) store.assignMaintenanceJob(job.id, req.user!.username);
    const result = await controller.exclusive(() => job.component_type === "gate"
      ? controller.manualGate(job.component, "repair", req.user!.username, job.reason, job.id)
      : job.component_type === "spot" ? controller.manualSpotRepair(job.component, req.user!.username, job.reason, job.id)
        : job.component_type === "fan" ? controller.manualFanRepair(job.component, req.user!.username, job.reason, job.id)
          : { ok: false, message: "light repair is not supported by the simulator API" });
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "maintenance.start",
      target: job.component, reason: job.reason, details: { job_id: job.id, ok: result.ok, message: result.message } });
    return reply.code(result.ok ? 200 : 409).send({ ...result, job: store.getMaintenanceJob(job.id) });
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/incidents", operationalRead, async (req): Promise<IncidentsResponse> => {
    const status = ["open", "acknowledged", "resolved"].includes(req.query.status ?? "")
      ? req.query.status as "open" | "acknowledged" | "resolved" : undefined;
    let items = store.listIncidents({ status, equipmentOnly: req.user!.role === "maintenance", limit: Number(req.query.limit) || 100 });
    if (req.user!.role === "maintenance") items = items.map((item) => ({ ...item, plate: null, details: {} }));
    return { items };
  });

  app.get<{ Params: { id: string } }>("/api/incidents/:id", operationalRead, async (req, reply): Promise<IncidentResponse | ApiError> => {
    const incident = store.getIncident(req.params.id);
    if (!incident) return err(reply, 404, "no such incident");
    if (req.user!.role === "maintenance" && !incident.component) return err(reply, 403, "Maintenance can view equipment incidents only");
    return { incident: req.user!.role === "maintenance" ? { ...incident, plate: null, details: {} } : incident };
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/acknowledge", operationalRead, async (req, reply) => {
    const incident = store.getIncident(req.params.id);
    if (!incident) return err(reply, 404, "no such incident");
    if (incident.status === "resolved") return err(reply, 409, "incident is already resolved");
    if (req.user!.role === "maintenance" && !incident.component) return err(reply, 403, "Maintenance can acknowledge equipment incidents only");
    const body = jsonBody<{ reason?: string }>(req);
    if (!body?.reason || body.reason.trim().length < 8) return err(reply, 400, "acknowledgement reason must be at least 8 characters");
    const updated = store.updateIncident(incident.id, "acknowledged", req.user!.username, body.reason.trim())!;
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "incident.acknowledged",
      target: incident.id, reason: body.reason.trim() });
    return { incident: updated };
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/resolve", admin, async (req, reply) => {
    const incident = store.getIncident(req.params.id);
    if (!incident) return err(reply, 404, "no such incident");
    if (incident.status === "resolved") return err(reply, 409, "incident is already resolved");
    if (["unknown_visit", "uncertain_reservation", "unverified_exit", "possible_tailgate", "uncertain_exit_passage",
      "manual_spot_occupancy"].includes(incident.type)) {
      return err(reply, 409, "this incident requires its domain recovery workflow; it cannot be closed by a generic status change");
    }
    const body = jsonBody<{ reason?: string }>(req);
    if (!body?.reason || body.reason.trim().length < 8) return err(reply, 400, "resolution reason must be at least 8 characters");
    const updated = store.updateIncident(incident.id, "resolved", req.user!.username, body.reason.trim())!;
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "incident.resolved",
      target: incident.id, reason: body.reason.trim() });
    return { incident: updated };
  });

  app.post<{ Params: { plate: string } }>("/api/visits/:plate/duration-review", operator, async (req, reply) => {
    const body = jsonBody<DurationReviewRequest>(req);
    if (!body || !Number.isInteger(body.expected_version) || !Number.isInteger(body.minutes) || typeof body.reason !== "string") return err(reply, 400, "expected_version, minutes, and reason are required");
    return control(reply, () => controller.exclusive(() =>
      controller.reviewUnknownDuration(req.params.plate, body.expected_version, body.minutes, body.reason, req.user!.username)));
  });

  app.post<{ Params: { id: string } }>("/api/visits/:id/reservation-review", operator, async (req, reply) => {
    const body = jsonBody<ReservationReviewRequest>(req);
    if (!body || typeof body.request_id !== "string" || body.request_id.trim().length < 8 ||
        !Number.isInteger(body.expected_version) || typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return err(reply, 400, "request_id, expected_version, and reason of at least 8 characters are required");
    }
    return control(reply, () => controller.exclusive(() => controller.reviewUncertainReservation(
      req.params.id, body.request_id.trim(), body.expected_version, body.reason, req.user!.username)));
  });

  app.post<{ Params: { id: string } }>("/api/visits/:id/adjustment", admin, async (req, reply) => {
    const body = jsonBody<VisitAdjustmentRequest>(req);
    if (!body || typeof body.request_id !== "string" || body.request_id.trim().length < 8 ||
        !Number.isInteger(body.expected_version) || !Number.isFinite(body.amount) || typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return err(reply, 400, "request_id, expected_version, finite amount, and reason of at least 8 characters are required");
    }
    return control(reply, () => controller.exclusive(() => controller.adminApplyFinancialAdjustment(
      req.params.id, body.request_id.trim(), body.expected_version, body.amount, body.reason, req.user!.username)));
  });

  app.post<{ Params: { id: string } }>("/api/visits/:id/waiver", admin, async (req, reply) => {
    const body = jsonBody<VisitExceptionRequest>(req);
    if (!body || typeof body.request_id !== "string" || body.request_id.trim().length < 8 ||
        !Number.isInteger(body.expected_version) || typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return err(reply, 400, "request_id, expected_version, and reason of at least 8 characters are required");
    }
    return control(reply, () => controller.exclusive(() => controller.adminWaiveVisit(
      req.params.id, body.request_id.trim(), body.expected_version, body.reason, req.user!.username)));
  });

  app.post<{ Params: { id: string } }>("/api/visits/:id/emergency-release", admin, async (req, reply) => {
    const body = jsonBody<VisitExceptionRequest>(req);
    if (!body || typeof body.request_id !== "string" || body.request_id.trim().length < 8 ||
        !Number.isInteger(body.expected_version) || typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return err(reply, 400, "request_id, expected_version, and reason of at least 8 characters are required");
    }
    return control(reply, () => controller.exclusive(() => controller.adminEmergencyRelease(
      req.params.id, body.request_id.trim(), body.expected_version, body.reason, req.user!.username)));
  });

  app.post<{ Params: { spot: string } }>("/api/exits/:spot/clearance", operator, async (req, reply) => {
    const body = jsonBody<{ reason?: string }>(req);
    if (!body?.reason || body.reason.trim().length < 8) return err(reply, 400, "clearance reason must be at least 8 characters");
    return control(reply, () => controller.exclusive(() =>
      controller.confirmExitClearance(req.params.spot, body.reason!.trim(), req.user!.username)));
  });

  // ---------------------------------------------------------------------------
  // manual control (operator+)
  // ---------------------------------------------------------------------------
  const control = async (reply: FastifyReply, run: () => Promise<ControlResult>) => {
    const result = await run();
    return reply.code(result.ok ? 200 : 409).send(result);
  };

  app.post<{ Params: { spot: string } }>("/api/spots/:spot/manual-occupancy/report", operator, async (req, reply) => {
    const body = jsonBody<ManualSpotOccupancyRequest>(req);
    if (!body || typeof body.request_id !== "string" || body.request_id.trim().length < 8 ||
        !Number.isInteger(body.expected_version) || body.expected_version < 0 || body.observed_occupied !== true ||
        typeof body.observation !== "string" || body.observation.trim().length < 8 ||
        typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return err(reply, 400, "request_id, expected_version, explicit occupied observation, observation notes, and reason are required");
    }
    return control(reply, async () => {
      const result = await controller.exclusive(() => controller.reportManualSpotOccupancy(req.params.spot,
        body.request_id, body.expected_version, body.observation, body.reason, req.user!.username, req.user!.id));
      store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "spot.manual_occupancy.report_attempt",
        target: req.params.spot, reason: body.reason.trim(), details: { request_id: body.request_id,
          expected_version: body.expected_version, observed_occupied: true, ok: result.ok, result: result.message } });
      return result;
    });
  });

  app.post<{ Params: { spot: string } }>("/api/spots/:spot/manual-occupancy/clear", operator, async (req, reply) => {
    const body = jsonBody<ManualSpotOccupancyClearRequest>(req);
    if (!body || typeof body.request_id !== "string" || body.request_id.trim().length < 8 ||
        !Number.isInteger(body.expected_version) || body.expected_version < 0 || body.observed_clear !== true ||
        typeof body.observation !== "string" || body.observation.trim().length < 8 ||
        typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return err(reply, 400, "request_id, expected_version, explicit physical-clearance observation, observation notes, and reason are required");
    }
    return control(reply, async () => {
      const result = await controller.exclusive(() => controller.clearManualSpotOccupancy(req.params.spot,
        body.request_id, body.expected_version, body.observation, body.reason, req.user!.username, req.user!.id));
      store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "spot.manual_occupancy.clear_attempt",
        target: req.params.spot, reason: body.reason.trim(), details: { request_id: body.request_id,
          expected_version: body.expected_version, observed_clear: true, ok: result.ok, result: result.message } });
      return result;
    });
  });

  app.post<{ Params: { name: string; action: string } }>("/api/control/gates/:name/:action", operationalRead, async (req, reply) => {
    const action = req.params.action as GateAction;
    if (!GATE_ACTIONS.includes(action)) return err(reply, 400, `action must be one of ${GATE_ACTIONS.join(", ")}`);
    if (action === "repair" && !hasRole(req.user, "maintenance")) return err(reply, 403, "gate repair requires Maintenance or Admin");
    if (action !== "repair" && !hasRole(req.user, "operator")) return err(reply, 403, "gate operation requires Operator or Admin");
    const body = action === "repair" ? jsonBody<{ reason?: string }>(req) : null;
    if (action === "repair" && (!body?.reason || body.reason.trim().length < 8)) return err(reply, 400, "repair reason must be at least 8 characters");
    return control(reply, async () => {
      const result = await controller.exclusive(() => controller.manualGate(req.params.name, action, req.user!.username, body?.reason));
      store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: `control.gate.${action}`,
        target: req.params.name, details: { ok: result.ok, message: result.message } });
      return result;
    });
  });

  app.post<{ Params: { name: string } }>("/api/control/spots/:name/repair", maintenance, async (req, reply) => {
    const body = jsonBody<{ reason?: string }>(req);
    if (!body?.reason || body.reason.trim().length < 8) return err(reply, 400, "repair reason must be at least 8 characters");
    return control(reply, async () => {
      const result = await controller.exclusive(() => controller.manualSpotRepair(req.params.name, req.user!.username, body.reason));
      store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "control.spot.repair",
        target: req.params.name, details: { ok: result.ok, message: result.message } });
      return result;
    });
  });

  // ---------------------------------------------------------------------------
  // administration (admin only)
  // ---------------------------------------------------------------------------
  app.post<{ Params: { spot: string; state: string } }>("/api/control/entries/:spot/:state", admin, async (req, reply) => {
    if (req.params.state !== "open" && req.params.state !== "close") return err(reply, 400, "state must be open or close");
    return control(reply, async () => {
      const result = await controller.exclusive(() =>
        controller.setEntryOpen(req.params.spot, req.params.state === "open", req.user!.username));
      store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "control.entry.change",
        target: req.params.spot, details: { state: req.params.state, ok: result.ok } });
      return result;
    });
  });

  app.post("/api/resync", admin, async (req) => {
    controller.requestResync();
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "system.resync" });
    controller.note("info", `${req.user!.username} requested a resync`);
    return { ok: true, message: "resync queued" } satisfies ControlResult;
  });

  app.get("/api/config", admin, async () => ({ ...cfg, simPassword: "***", adminPassword: cfg.adminPassword ? "***" : undefined }));

  app.get("/api/simulator-clock", admin, async () => controller.simulatorCalendar.status());

  app.post("/api/simulator-clock/anchor", admin, async (req, reply) => {
    const body = jsonBody<SimulatorClockAnchorRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (typeof body.run_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.run_id.trim())) {
      return err(reply, 400, "run_id must be 1-128 letters, digits, dot, underscore, colon, or hyphen");
    }
    if (typeof body.simulator_time_iso !== "string") return err(reply, 400, "simulator_time_iso is required");
    if (typeof body.calendar_seconds_per_real_second !== "number" ||
      !Number.isFinite(body.calendar_seconds_per_real_second) || body.calendar_seconds_per_real_second <= 0) {
      return err(reply, 400, "calendar_seconds_per_real_second must be a positive finite number");
    }
    if (typeof body.day_start_minute !== "number" || !Number.isInteger(body.day_start_minute) ||
      body.day_start_minute < 0 || body.day_start_minute >= 1440) return err(reply, 400, "day_start_minute must be an integer from 0 to 1439");
    if (typeof body.night_start_minute !== "number" || !Number.isInteger(body.night_start_minute) ||
      body.night_start_minute < 0 || body.night_start_minute >= 1440) return err(reply, 400, "night_start_minute must be an integer from 0 to 1439");
    if (body.day_start_minute === body.night_start_minute) return err(reply, 400, "day and night start minutes must differ");
    if (typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.trim().length > 500) {
      return err(reply, 400, "reason must contain 8-500 characters");
    }

    const realAnchorMs = performance.now();
    const recordedAt = new Date().toISOString();
    const anchor = {
      simulatorTimeIso: body.simulator_time_iso.trim(), realAnchorMs,
      calendarSecondsPerRealSecond: body.calendar_seconds_per_real_second,
      dayStartMinute: body.day_start_minute, nightStartMinute: body.night_start_minute,
      processInstanceToken: controller.processInstanceToken,
    };
    const candidate = new SimulatorCalendar(anchor, controller.processInstanceToken).isNight(realAnchorMs);
    if (candidate.status !== "available") return err(reply, 400, `invalid manual calendar anchor: ${candidate.reason}`);
    const before = controller.simulatorCalendar.status(realAnchorMs);
    const after = {
      status: "available", confidence: "manual", reason: null, run_id: body.run_id.trim(),
      modeled_time: candidate.simulatorTimeIso, simulator_epoch_ms: candidate.simulatorEpochMs,
      is_night: candidate.isNight, minute_of_day: candidate.minuteOfDay,
      day_start_minute: candidate.dayStartMinute, night_start_minute: candidate.nightStartMinute,
      calendar_seconds_per_real_second: candidate.calendarSecondsPerRealSecond,
      source: "administrator_anchor", anchored_at: recordedAt,
    };
    store.appendSimulatorCalendarRecord({ action: "anchor", runId: body.run_id.trim(),
      simulatorTimeIso: anchor.simulatorTimeIso, realAnchorMs, calendarSecondsPerRealSecond: anchor.calendarSecondsPerRealSecond,
      dayStartMinute: anchor.dayStartMinute, nightStartMinute: anchor.nightStartMinute,
      processInstanceToken: controller.processInstanceToken, reason: body.reason.trim(), recordedAt },
    { actorId: req.user!.id, actorUsername: req.user!.username, before, after });
    return controller.simulatorCalendar.status(performance.now());
  });

  app.post("/api/simulator-clock/invalidate", admin, async (req, reply) => {
    const body = jsonBody<SimulatorClockInvalidateRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.trim().length > 500) {
      return err(reply, 400, "reason must contain 8-500 characters");
    }
    const current = store.latestSimulatorCalendarRecord();
    const runId = current?.runId ?? null;
    const before = controller.simulatorCalendar.status(performance.now());
    const after = {
      status: "unavailable", confidence: "none", reason: "manual_invalidation", run_id: runId,
      modeled_time: null, simulator_epoch_ms: null, is_night: null, day_start_minute: null,
      night_start_minute: null, calendar_seconds_per_real_second: null, source: null, anchored_at: null,
    };
    store.appendSimulatorCalendarRecord({ action: "invalidate", runId, reason: body.reason.trim(), recordedAt: new Date().toISOString() },
      { actorId: req.user!.id, actorUsername: req.user!.username, before, after });
    return controller.simulatorCalendar.status(performance.now());
  });

  app.get("/api/users", admin, async (): Promise<UsersResponse> => ({ items: store.listUsers() }));
  app.get<{ Querystring: { limit?: string } }>("/api/audit", admin, async (req): Promise<AuditResponse> => ({
    items: store.searchAudit(Number(req.query.limit) || 100),
  }));

  app.post("/api/users", admin, async (req, reply) => {
    const body = jsonBody<CreateUserRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== "admin" && body.role !== "operator" && body.role !== "maintenance") return err(reply, 400, "role must be admin, operator, or maintenance");
    const problem = validateCredentials(body.username ?? "", body.password ?? "");
    if (problem) return err(reply, 400, problem);
    if (store.findUser(body.username)) return err(reply, 409, `user ${body.username} already exists`);
    const user = store.createUser(body.username, await hashPassword(body.password), body.role);
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "user.create", target: user.username, details: { role: user.role } });
    controller.note("info", `${req.user!.username} created ${user.role} ${user.username}`);
    return reply.code(201).send({ user } satisfies MeResponse);
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", admin, async (req, reply) => {
    const id = Number(req.params.id);
    const target = store.getUser(id);
    if (!target) return err(reply, 404, "no such user");
    const body = jsonBody<UpdateUserRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "operator" && body.role !== "maintenance") return err(reply, 400, "role must be admin, operator, or maintenance");
    if (body.password !== undefined) {
      const problem = validateCredentials(undefined, body.password);
      if (problem) return err(reply, 400, problem);
    }
    const losesAdmin = target.role === "admin" && (body.role === "operator" || body.disabled === true);
    if (losesAdmin && store.countOtherActiveAdmins(id) === 0) return err(reply, 409, "cannot remove the last active admin");
    if (id === req.user!.id && body.disabled === true) return err(reply, 409, "you cannot disable your own account");

    const user = store.updateUser(id, {
      role: body.role, disabled: body.disabled,
      passwordHash: body.password !== undefined ? await hashPassword(body.password) : undefined,
    })!;
    store.recordAudit({ actorId: req.user!.id, actorUsername: req.user!.username, action: "user.update", target: user.username,
      details: { role: body.role, disabled: body.disabled, password_reset: body.password !== undefined } });
    // New password, role or disabled: existing sign-ins must not keep the old rights.
    if (body.password !== undefined || body.role !== undefined || body.disabled) auth.revokeAll(id);
    const what = [body.role && `role ${body.role}`, body.disabled !== undefined && (body.disabled ? "disabled" : "enabled"),
      body.password !== undefined && "password reset"].filter(Boolean).join(", ");
    controller.note("info", `${req.user!.username} updated ${user.username}: ${what}`);
    return { user } satisfies MeResponse;
  });

  // ---------------------------------------------------------------------------
  // debug (the tools use these from this machine)
  // ---------------------------------------------------------------------------
  app.get("/debug/stats", debugAccess, async () => ({
    ...intake.stats, last_sequence_id: intake.lastSeq, controller_enabled: cfg.controllerEnabled,
  }));
  app.get<{ Querystring: { n?: string } }>("/debug/recent", debugAccess, async (req) => recent.slice(-(Number(req.query.n) || 20)));
  app.get("/debug/config", debugAccess, async () => ({ ...cfg, simPassword: "***", adminPassword: cfg.adminPassword ? "***" : undefined }));

  // ---------------------------------------------------------------------------
  // the built dashboard (npm run build), if present - one port for everything
  // ---------------------------------------------------------------------------
  const dist = path.join(REPO_ROOT, "web", "dist");
  if (existsSync(path.join(dist, "index.html"))) {
    const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
      ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
    app.get("/*", async (req, reply) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
      const file = path.resolve(dist, rel);
      const inside = file.startsWith(dist + path.sep);
      const target = inside && existsSync(file) && !file.endsWith(path.sep) && path.extname(file) ? file : path.join(dist, "index.html");
      return reply.type(types[path.extname(target)] ?? "application/octet-stream").send(readFileSync(target));
    });
  }
}
