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
import { DEVICE_ACTIONS } from "@gpa/shared";
import type {
  ActionsResponse, ApiError, ControlResult, CreateUserRequest, DeliveriesResponse, DeliveryRejection, DeviceAction, EventsResponse,
  GateAction, LoginRequest, MeResponse, Role,
  ComponentsResponse, SessionsResponse, StateSnapshot, StatsResponse, TimeseriesResponse, UpdateUserRequest, UserView, UsersResponse,
} from "@gpa/shared";
import { DELIVERY_REJECTIONS } from "@gpa/shared";
import { AuthService, hashPassword, hasRole, validateCredentials } from "./auth";
import { REPO_ROOT, type Settings } from "./config";
import type { Controller } from "./controller";
import type { EventRecord, Store } from "./store";
import { Intake, RateLimiter, parseRaw } from "./webhook";

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

export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { cfg, controller, store, auth } = deps;
  const intake = deps.intake ?? new Intake(cfg.signatureMode, cfg.webhookDedupeCacheSize);
  const limiter = new RateLimiter(cfg.webhookRatePerSourcePerS, cfg.webhookRateBurst);
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
  const admin = { preHandler: guard("admin") };
  const debugAccess = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isLoopback(req.ip) && !hasRole(req.user, "admin")) return err(reply, 403, "debug endpoints: this machine or an admin only");
    },
  };

  // ---------------------------------------------------------------------------
  // simulator -> us
  // ---------------------------------------------------------------------------
  /**
   * The simulator's only way in. Every delivery - accepted or not - is written to the
   * events table with its payload, source and the reason it was refused, because those
   * rows are the evidence the security page shows and the only record of an attack.
   * The response never waits on the engine: the record is persisted, the work is queued.
   */
  app.post("/webhook", async (req, reply) => {
    const receivedAt = new Date().toISOString();
    const source = req.ip;
    /** Store the delivery exactly as it arrived, whatever we decide about it. */
    const record = (event: Record<string, unknown>, rejection: DeliveryRejection | null, meta: Partial<EventRecord> = {}) => {
      const row: EventRecord = {
        EventClass: "?", ...event, _received_at: receivedAt, _source: source, _rejection: rejection,
        _accepted: rejection === null, ...meta,
      } as EventRecord;
      store.recordEvent(row);
      recent.push(row);
      if (recent.length > cfg.recentEventsSize) recent.shift();
      return row;
    };
    const refuse = (rejection: Extract<DeliveryRejection, "rate_limited" | "malformed" | "forbidden_source">,
      event: Record<string, unknown>, reason: string) => {
      intake.countRefused(rejection);
      record(event, rejection);
      store.recordAudit({ action: "webhook.rejected", target: source, ok: false, reason });
      req.log.warn(`refused a delivery from ${source}: ${reason}`);
    };

    if (!limiter.allow(source)) {
      refuse("rate_limited", { EventClass: "?" }, `more than ${cfg.webhookRatePerSourcePerS}/s from this source`);
      reply.header("retry-after", "1");
      return err(reply, 429, "too many webhook deliveries from this source");
    }

    let event;
    try {
      event = parseRaw(String(req.body ?? ""));
    } catch {
      // Keep the body: unparseable deliveries are the clearest sign of something that is
      // not the simulator talking to us. Truncated so one huge body cannot fill the disk.
      refuse("malformed", { EventClass: "?", _raw_body: String(req.body ?? "").slice(0, 2000) }, "malformed JSON");
      return reply.code(400).send({ ok: false });
    }
    if (typeof event.EventClass !== "string" || !event.EventClass) {
      refuse("malformed", { ...event, EventClass: "?" }, "missing EventClass");
      return err(reply, 400, "webhook EventClass is required");
    }

    const level2 = cfg.levelProfile === "level2" || cfg.levelProfile === "level3" ||
      (cfg.levelProfile === "auto" && (/lvl[23]/i.test(deps.controller.topology?.name ?? "") ||
        deps.controller.components.all("fan").length > 0 || deps.controller.components.all("light").length > 0));
    if ((level2 && cfg.webhookLoopbackOnly) && !isLoopback(source)) {
      refuse("forbidden_source", event, "non-loopback Level 2 ingress");
      return err(reply, 403, "Level 2 webhooks are restricted to loopback");
    }

    // Durable: event_identities holds the payload hash of the first delivery of each
    // EventId, so a duplicate or a rewrite is still recognised after a restart.
    const identity = store.eventIdentity(event.EventId, event);
    const mode = cfg.signatureMode === "strict" || level2 ? "strict" : cfg.signatureMode;
    const meta = intake.check(event, { identity, mode, replayWindowS: cfg.webhookReplayWindowS });
    const row = record(event, meta.rejection, { _sig: meta.sig, _duplicate: meta.duplicate, _seq_note: meta.seqNote });

    if (meta.seqNote) req.log.warn(`sequence gap: ${meta.seqNote}`);
    if (meta.rejection) {
      req.log.warn(`dropped ${event.EventClass} (${meta.rejection})`);
      store.recordAudit({ action: "webhook.rejected", target: String(event.EventId ?? event.EventClass), ok: false,
        reason: meta.rejection, detail: { source, sig: meta.sig, event_class: event.EventClass } });
      // Same EventId, different payload: worth an operator's attention, not just a log line.
      if (meta.rejection === "tampered") {
        store.createIncident({ status: "open", kind: "event_id_conflict", confidence: "high",
          reason: `EventId ${event.EventId} was delivered again with a different payload`,
          evidence: { event_id: event.EventId, source, payload: event } });
      }
      // The controller still needs to see a badly signed payment: that is the spec's fake
      // payment, and the car must be re-charged rather than released.
      if (meta.rejection === "bad_signature" && cfg.controllerEnabled) controller.submitRejected(row);
    } else if (cfg.controllerEnabled) {
      controller.submit(row); // handled on the controller's queue; respond immediately
    }
    if (meta.rejection === "tampered") return err(reply, 409, "event ID was already used for a different payload");
    if (meta.rejection === "stale") return err(reply, 400, "ServerDateTime is outside the accepted window");
    // A duplicate is acknowledged: the simulator retried a delivery we already have, and
    // answering with an error would only make it retry again.
    if (meta.rejection && meta.rejection !== "duplicate" && mode === "strict") {
      return err(reply, 401, "valid webhook signature required");
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // authentication
  // ---------------------------------------------------------------------------
  app.post("/api/auth/login", async (req, reply) => {
    const body = jsonBody<LoginRequest>(req);
    if (!body?.username || !body?.password) return err(reply, 400, "username and password are required");
    const result = await auth.login(String(body.username), String(body.password), { ip: req.ip });
    if (!result.ok) {
      if (result.reason === "throttled") {
        reply.header("retry-after", String(result.retryAfterS));
        return err(reply, 429, `too many failed attempts - try again in ${result.retryAfterS}s`);
      }
      return err(reply, 401, "wrong username or password");
    }
    setSessionCookie(reply, result.token, cfg.sessionTtlH * 3600);
    req.log.warn(`sign-in: ${result.user.username} (${result.user.role})`);
    return { user: result.user, previous_login_attempts: result.previousAttempts } satisfies MeResponse;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(cookies(req)[SESSION_COOKIE]);
    setSessionCookie(reply, "", 0);
    return { ok: true };
  });

  app.get("/api/auth/me", operator, async (req): Promise<MeResponse> => ({
    user: req.user!, previous_login_attempts: store.listLoginAttempts(req.user!.username, 3),
  }));
  app.get<{ Querystring: { limit?: string } }>("/api/auth/login-attempts", operator, async (req) => ({
    items: store.listLoginAttempts(req.user!.username, Math.min(Number(req.query.limit) || 3, 50)),
  }));

  // ---------------------------------------------------------------------------
  // live state (operator+)
  // ---------------------------------------------------------------------------
  app.get("/api/state", operator, async (): Promise<StateSnapshot> => controller.snapshot());

  /** Server-sent events: a snapshot every streamIntervalS, until the session ends. */
  app.get("/api/stream", operator, (req, reply) => {
    const token = cookies(req)[SESSION_COOKIE];
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = () => res.write(`data: ${JSON.stringify(controller.snapshot())}\n\n`);
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

  app.get("/api/timeseries", operator, async (): Promise<TimeseriesResponse> =>
    ({ sample_s: cfg.statsSampleS, points: controller.timeseries }));

  // Every gate, spot, fan and light with health and usage, plus breakdown/repair history.
  app.get<{ Querystring: { name?: string; limit?: string } }>("/api/components", operator, async (req): Promise<ComponentsResponse> => ({
    items: controller.components.views(),
    events: store.listComponentEvents({ name: req.query.name || undefined, limit: Number(req.query.limit) || 200 }),
  }));

  app.get<{ Querystring: { kind?: string; zone?: string; limit?: string } }>("/api/equipment", operator, async (req) => {
    const items = controller.components.views().filter((c) => (!req.query.kind || c.kind === req.query.kind) && (!req.query.zone || c.zone === req.query.zone));
    return { items: items.slice(0, Math.min(Number(req.query.limit) || 500, 1000)) };
  });

  app.post<{ Params: { id: string } }>("/api/equipment/:id/maintenance", operator, async (req, reply) => {
    const [kind, ...nameParts] = decodeURIComponent(req.params.id).split(":");
    const target = `${kind}:${nameParts.join(":")}`;
    const audit = { actor: req.user!.username, action: "component.repair", target, permission: "repair" };
    if (kind === "gate") return control(reply, () => controller.exclusive(() => controller.manualGate(nameParts.join(":"), "repair", req.user!.username)), audit);
    if (kind === "spot") return control(reply, () => controller.exclusive(() => controller.manualSpotRepair(nameParts.join(":"), req.user!.username)), audit);
    if (kind === "fan" || kind === "light") return control(reply, () => controller.exclusive(() => controller.manualComponentRepair(kind, nameParts.join(":"), req.user!.username)), audit);
    return err(reply, 400, "equipment id must be kind:name");
  });

  app.get<{ Querystring: { limit?: string } }>("/api/maintenance", operator, async (req) => ({
    items: store.listMaintenanceJobs(Number(req.query.limit) || 100),
  }));

  app.get<{ Querystring: { status?: "open" | "provisional" | "resolved" | "dismissed"; limit?: string } }>("/api/incidents", operator, async (req) => ({
    items: store.listIncidents({ status: req.query.status, limit: Number(req.query.limit) || 100 }),
  }));
  app.get<{ Params: { id: string } }>("/api/incidents/:id", operator, async (req, reply) => {
    const incident = store.getIncident(Number(req.params.id));
    return incident ? incident : err(reply, 404, "no such incident");
  });
  app.post<{ Params: { id: string } }>("/api/incidents/:id/resolve", operator, async (req, reply) => {
    const body = jsonBody<{ resolution?: string; status?: "resolved" | "dismissed" }>(req);
    if (!body?.resolution?.trim()) return err(reply, 400, "resolution is required");
    return controller.exclusive(async () => {
      const resolved = store.resolveIncident(Number(req.params.id), req.user!.username, body.resolution!.trim(), body.status ?? "resolved");
      if (!resolved) return err(reply, 404, "no such incident");
      store.recordAudit({ actor: req.user!.username, action: "incident.resolve", target: req.params.id, ok: true, reason: body.resolution });
      return resolved;
    });
  });

  app.get("/api/penalties", operator, async (): Promise<{ items: ReturnType<Store["listPenalties"]> }> => ({ items: store.listPenalties() }));

  app.get<{ Querystring: { minutes?: string } }>("/api/stats", operator, async (req): Promise<StatsResponse> => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 7 * 24 * 60);
    const bucket = BUCKETS_S.find((b) => (minutes * 60) / b <= 40) ?? BUCKETS_S.at(-1)!;
    const until = Date.now();
    return store.stats(until - minutes * 60_000, until, bucket);
  });

  const dailyReport = (day: string, kind: "operations" | "financial") => {
    const start = Date.parse(`${day}T00:00:00Z`), end = start + 86_400_000;
    const stats = store.stats(start, end, 3600);
    const invoiceCount = store.db.prepare("SELECT count(*) n FROM invoices WHERE created_at >= ? AND created_at < ?")
      .get(new Date(start).toISOString(), new Date(end).toISOString()) as { n: number };
    const uncertainCount = store.db.prepare("SELECT count(*) n FROM invoices WHERE status IN ('intended', 'outcome_unknown') AND created_at >= ? AND created_at < ?")
      .get(new Date(start).toISOString(), new Date(end).toISOString()) as { n: number };
    const totals = kind === "financial"
      ? { ...stats.totals, invoices: Number(invoiceCount.n ?? 0), uncertain_payments: Number(uncertainCount.n ?? 0) }
      : { arrivals: stats.totals.arrivals, departures: stats.totals.departures, turned_away: stats.totals.turned_away,
        neglected: stats.totals.neglected, lost: stats.totals.lost, penalties: stats.totals.penalties, fines: stats.totals.fines,
        payment_mismatches: stats.totals.payment_mismatches, escaped: stats.totals.escaped };
    return { run_id: null, day, kind, time_basis: "UTC received time; simulator calendar is provisional until anchored",
      provisional: true, generated_at: new Date().toISOString(), totals,
      equipment: controller.components.views() as unknown as Record<string, unknown>[],
      incidents: store.listIncidents({ limit: 1000, since: new Date(start).toISOString(), until: new Date(end).toISOString() }),
      penalties: store.listPenalties(1000, { sinceMs: start, untilMs: end }) };
  };
  const csv = (report: ReturnType<typeof dailyReport>) => {
    const rows = [["field", "value"], ...Object.entries(report.totals).map(([k, v]) => [k, String(v)])];
    return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n") + "\n";
  };
  app.get<{ Querystring: { day?: string; kind?: "operations" | "financial" } }>("/api/reports/daily", operator, async (req, reply) => {
    const kind = req.query.kind ?? "operations";
    if (kind !== "operations" && kind !== "financial") return err(reply, 400, "kind must be operations or financial");
    if (kind === "financial" && !hasRole(req.user, "admin")) return err(reply, 403, "requires the admin role");
    const day = req.query.day ?? new Date().toISOString().slice(0, 10);
    const parsed = Date.parse(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed)) return err(reply, 400, "day must be a real YYYY-MM-DD date");
    const report = dailyReport(day, kind);
    if (kind === "financial") store.recordAudit({ actor: req.user!.username, permission: "reports.financial", action: "report.view", target: report.day, ok: true });
    return report;
  });
  app.get<{ Querystring: { day?: string; kind?: "operations" | "financial" } }>("/api/reports/daily/export", operator, async (req, reply) => {
    const kind = req.query.kind ?? "operations";
    if (kind !== "operations" && kind !== "financial") return err(reply, 400, "kind must be operations or financial");
    if (kind === "financial" && !hasRole(req.user, "admin")) return err(reply, 403, "requires the admin role");
    const day = req.query.day ?? new Date().toISOString().slice(0, 10);
    const parsed = Date.parse(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed)) return err(reply, 400, "day must be a real YYYY-MM-DD date");
    const report = dailyReport(day, kind);
    store.recordAudit({ actor: req.user!.username, permission: kind === "financial" ? "reports.financial" : "view",
      action: "report.export", target: report.day, ok: true });
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename=report-${report.day}-${kind}.csv`).send(csv(report));
  });

  // ---------------------------------------------------------------------------
  // logs (operator+)
  // ---------------------------------------------------------------------------
  type ListQuery = { plate?: string; status?: string; class?: string; since?: string; until?: string; limit?: string; before?: string };
  const num = (v?: string) => (v ? Number(v) || undefined : undefined);

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

  // ---------------------------------------------------------------------------
  // manual control (operator+)
  // ---------------------------------------------------------------------------
  const control = async (reply: FastifyReply, run: () => Promise<ControlResult>, audit?: { actor: string; action: string; target: string; permission?: string }) => {
    const result = await run();
    if (audit) store.recordAudit({ ...audit, ok: result.ok, reason: result.ok ? undefined : result.message });
    return reply.code(result.ok ? 200 : 409).send(result);
  };

  app.post<{ Params: { plate: string } }>("/api/control/cars/:plate/reconcile", operator, async (req, reply) => {
    const body = jsonBody<{ minutes?: number }>(req);
    if (!body || !Number.isInteger(body.minutes)) return err(reply, 400, "minutes must be an integer");
    return control(reply, () => controller.exclusive(() => controller.manualReconcileCar(decodeURIComponent(req.params.plate), body.minutes!, req.user!.username)),
      { actor: req.user!.username, action: "car.manual_reconcile", target: decodeURIComponent(req.params.plate), permission: "reconcile" });
  });

  app.post<{ Params: { name: string; action: string } }>("/api/control/gates/:name/:action", operator, async (req, reply) => {
    const action = req.params.action as GateAction;
    if (!GATE_ACTIONS.includes(action)) return err(reply, 400, `action must be one of ${GATE_ACTIONS.join(", ")}`);
    return control(reply, () => controller.exclusive(() => controller.manualGate(req.params.name, action, req.user!.username)),
      { actor: req.user!.username, action: `gate.${action}`, target: req.params.name, permission: "control" });
  });

  /** Exhaust fans and lights, the same way a gate is held: on / off / auto. */
  app.post<{ Params: { kind: string; name: string; action: string } }>(
    "/api/control/devices/:kind/:name/:action", operator, async (req, reply) => {
      const { kind, action } = req.params;
      const name = decodeURIComponent(req.params.name);
      if (kind !== "fan" && kind !== "light") return err(reply, 400, "kind must be fan or light");
      if (!DEVICE_ACTIONS.includes(action as DeviceAction)) {
        return err(reply, 400, `action must be one of ${DEVICE_ACTIONS.join(", ")}`);
      }
      return control(reply, () => controller.exclusive(() => controller.manualDevice(kind, name, action, req.user!.username)),
        { actor: req.user!.username, action: `${kind}.${action}`, target: name, permission: "control" });
    });

  app.post<{ Params: { name: string } }>("/api/control/spots/:name/repair", operator, async (req, reply) =>
    control(reply, () => controller.exclusive(() => controller.manualSpotRepair(req.params.name, req.user!.username)),
      { actor: req.user!.username, action: "spot.repair", target: req.params.name, permission: "repair" }));

  // ---------------------------------------------------------------------------
  // administration (admin only)
  // ---------------------------------------------------------------------------
  app.post<{ Params: { spot: string; state: string } }>("/api/control/entries/:spot/:state", admin, async (req, reply) => {
    if (req.params.state !== "open" && req.params.state !== "close") return err(reply, 400, "state must be open or close");
    return control(reply, () => controller.exclusive(() =>
      controller.setEntryOpen(req.params.spot, req.params.state === "open", req.user!.username)),
      { actor: req.user!.username, action: `entrance.${req.params.state}`, target: req.params.spot, permission: "control" });
  });

  app.post("/api/resync", admin, async (req) => {
    controller.requestResync();
    controller.note("info", `${req.user!.username} requested a resync`);
    store.recordAudit({ actor: req.user!.username, permission: "config", action: "site.resync", target: "simulator", ok: true });
    return { ok: true, message: "resync queued" } satisfies ControlResult;
  });

  app.get("/api/config", admin, async () => ({ ...cfg, simPassword: "***", adminPassword: cfg.adminPassword ? "***" : undefined }));

  app.get("/api/users", admin, async (): Promise<UsersResponse> => ({ items: store.listUsers() }));
  app.get<{ Querystring: { limit?: string } }>("/api/audit", admin, async (req) => ({ items: store.listAudit(Number(req.query.limit) || 100) }));
  app.get<{ Querystring: { limit?: string } }>("/api/security/login-attempts", admin, async (req) => ({ items: store.listLoginAttemptsForAdmin(Number(req.query.limit) || 100) }));

  /**
   * Every delivery the parking network made, with the reason it was refused - the
   * "invalid / duplicated / tampered requests" admin view the brief asks for. Admin only:
   * the payloads contain plates and signatures.
   */
  app.get<{ Querystring: { rejection?: string; class?: string; source?: string; q?: string; since?: string; until?: string; limit?: string; offset?: string } }>(
    "/api/security/deliveries", admin, async (req, reply): Promise<DeliveriesResponse | ApiError> => {
      const rejection = req.query.rejection;
      if (rejection && rejection !== "any" && !DELIVERY_REJECTIONS.includes(rejection as DeliveryRejection)) {
        return err(reply, 400, `rejection must be "any" or one of ${DELIVERY_REJECTIONS.join(", ")}`);
      }
      const page = store.listDeliveries({
        rejection: rejection as DeliveryRejection | "any" | undefined, eventClass: req.query.class,
        source: req.query.source, search: req.query.q, since: req.query.since, until: req.query.until,
        limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0,
      });
      return { ...page, counts: store.deliveryCounts({ since: req.query.since, until: req.query.until }) };
    });

  /** Live intake counters (this process) next to the durable ones above. */
  app.get("/api/security/intake", admin, async () => ({ ...intake.stats, last_sequence_id: intake.lastSeq,
    signature_mode: cfg.signatureMode, replay_window_s: cfg.webhookReplayWindowS,
    rate_limit_per_source_per_s: cfg.webhookRatePerSourcePerS }));

  app.post("/api/users", admin, async (req, reply) => {
    const body = jsonBody<CreateUserRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== "admin" && body.role !== "operator") return err(reply, 400, "role must be admin or operator");
    const problem = validateCredentials(body.username ?? "", body.password ?? "");
    if (problem) return err(reply, 400, problem);
    if (store.findUser(body.username)) return err(reply, 409, `user ${body.username} already exists`);
    const user = store.createUser(body.username, await hashPassword(body.password), body.role);
    controller.note("info", `${req.user!.username} created ${user.role} ${user.username}`);
    store.recordAudit({ actor: req.user!.username, permission: "users.manage", action: "user.create", target: `user:${user.username}`, ok: true,
      detail: { role: user.role } });
    return reply.code(201).send({ user } satisfies MeResponse);
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", admin, async (req, reply) => {
    const id = Number(req.params.id);
    const target = store.getUser(id);
    if (!target) return err(reply, 404, "no such user");
    const body = jsonBody<UpdateUserRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "operator") return err(reply, 400, "role must be admin or operator");
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
    // New password, role or disabled: existing sign-ins must not keep the old rights.
    if (body.password !== undefined || body.role !== undefined || body.disabled) auth.revokeAll(id);
    const what = [body.role && `role ${body.role}`, body.disabled !== undefined && (body.disabled ? "disabled" : "enabled"),
      body.password !== undefined && "password reset"].filter(Boolean).join(", ");
    controller.note("info", `${req.user!.username} updated ${user.username}: ${what}`);
    store.recordAudit({ actor: req.user!.username, permission: "users.manage", action: "user.update", target: `user:${user.username}`, ok: true,
      detail: { changes: what } });
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
  // Read-only controller view used by the live diagnostics. Keep this on the
  // loopback/debug surface; the authenticated dashboard uses /api/state.
  app.get("/debug/controller", debugAccess, async () => {
    const s = controller.snapshot();
    return {
      synced: s.synced, topology: s.topology?.name ?? null, time_scale: s.time_scale, time_scale_source: s.time_scale_source,
      queue: s.queue ?? null,
      entry_lanes: s.entry_lanes, exit_lanes: s.exit_lanes,
      gates: s.gates.map((g) => {
        const c = s.components.find((x) => x.kind === "gate" && x.name === g.name);
        return { ...g, uses: c?.uses ?? null, worn: controller.components.wornOut("gate", g.name), waiting: c?.waiting ?? null };
      }),
      gate_limit: controller.components.limit("gate"),
      out_of_service: s.components.filter((c) => c.health !== "ok").map((c) => `${c.kind} ${c.name} ${c.health}${c.waiting ? ` (${c.waiting})` : ""}`),
      zones: s.zones, spots: s.spots, components: s.components, active_cars: s.active_cars,
      environment: s.subsystems.environment ?? null, unreachable: [...controller.unreachable],
      cars: s.active_cars.length, counters: s.counters, feed: s.feed.slice(-40),
    };
  });

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
