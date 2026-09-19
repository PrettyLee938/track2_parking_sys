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
  ActionsResponse, ApiError, ControlResult, CreateUserRequest, EventsResponse, GateAction, LoginRequest, MeResponse, Role,
  SessionsResponse, StateSnapshot, StatsResponse, TimeseriesResponse, UpdateUserRequest, UserView, UsersResponse,
} from "@gpa/shared";
import { AuthService, hashPassword, hasRole, validateCredentials } from "./auth";
import { REPO_ROOT, type Settings } from "./config";
import type { Controller } from "./controller";
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

export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { cfg, controller, store, auth } = deps;
  const intake = deps.intake ?? new Intake(cfg.signatureMode);
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
  app.post("/webhook", async (req) => {
    const receivedAt = new Date().toISOString();
    let event;
    try {
      event = parseRaw(String(req.body ?? ""));
    } catch {
      req.log.error({ body: String(req.body).slice(0, 300) }, "non-JSON webhook");
      return { ok: false };
    }
    const meta = intake.check(event);
    const record: EventRecord = {
      ...event, _received_at: receivedAt, _sig: meta.sig, _duplicate: meta.duplicate,
      _seq_note: meta.seqNote, _accepted: meta.accept,
    };
    store.recordEvent(record);
    recent.push(record);
    if (recent.length > cfg.recentEventsSize) recent.shift();

    if (meta.seqNote) req.log.warn(`sequence gap: ${meta.seqNote}`);
    if (!meta.accept) {
      req.log.warn(`dropped ${event.EventClass} (${meta.duplicate ? "duplicate" : `signature ${meta.sig}`})`);
    } else if (cfg.controllerEnabled) {
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
    const result = await auth.login(String(body.username), String(body.password));
    if (!result.ok) {
      if (result.reason === "throttled") {
        reply.header("retry-after", String(result.retryAfterS));
        return err(reply, 429, `too many failed attempts - try again in ${result.retryAfterS}s`);
      }
      return err(reply, 401, "wrong username or password");
    }
    setSessionCookie(reply, result.token, cfg.sessionTtlH * 3600);
    req.log.warn(`sign-in: ${result.user.username} (${result.user.role})`);
    return { user: result.user } satisfies MeResponse;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(cookies(req)[SESSION_COOKIE]);
    setSessionCookie(reply, "", 0);
    return { ok: true };
  });

  app.get("/api/auth/me", operator, async (req): Promise<MeResponse> => ({ user: req.user! }));

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

  app.get<{ Querystring: { minutes?: string } }>("/api/stats", operator, async (req): Promise<StatsResponse> => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 7 * 24 * 60);
    const bucket = BUCKETS_S.find((b) => (minutes * 60) / b <= 40) ?? BUCKETS_S.at(-1)!;
    const until = Date.now();
    return store.stats(until - minutes * 60_000, until, bucket);
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
  const control = async (reply: FastifyReply, run: () => Promise<ControlResult>) => {
    const result = await run();
    return reply.code(result.ok ? 200 : 409).send(result);
  };

  app.post<{ Params: { name: string; action: string } }>("/api/control/gates/:name/:action", operator, async (req, reply) => {
    const action = req.params.action as GateAction;
    if (!GATE_ACTIONS.includes(action)) return err(reply, 400, `action must be one of ${GATE_ACTIONS.join(", ")}`);
    return control(reply, () => controller.exclusive(() => controller.manualGate(req.params.name, action, req.user!.username)));
  });

  app.post<{ Params: { name: string } }>("/api/control/spots/:name/repair", operator, async (req, reply) =>
    control(reply, () => controller.exclusive(() => controller.manualSpotRepair(req.params.name, req.user!.username))));

  // ---------------------------------------------------------------------------
  // administration (admin only)
  // ---------------------------------------------------------------------------
  app.post<{ Params: { spot: string; state: string } }>("/api/control/entries/:spot/:state", admin, async (req, reply) => {
    if (req.params.state !== "open" && req.params.state !== "close") return err(reply, 400, "state must be open or close");
    return control(reply, () => controller.exclusive(() =>
      controller.setEntryOpen(req.params.spot, req.params.state === "open", req.user!.username)));
  });

  app.post("/api/resync", admin, async (req) => {
    controller.requestResync();
    controller.note("info", `${req.user!.username} requested a resync`);
    return { ok: true, message: "resync queued" } satisfies ControlResult;
  });

  app.get("/api/config", admin, async () => ({ ...cfg, simPassword: "***", adminPassword: cfg.adminPassword ? "***" : undefined }));

  app.get("/api/users", admin, async (): Promise<UsersResponse> => ({ items: store.listUsers() }));

  app.post("/api/users", admin, async (req, reply) => {
    const body = jsonBody<CreateUserRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== "admin" && body.role !== "operator") return err(reply, 400, "role must be admin or operator");
    const problem = validateCredentials(body.username ?? "", body.password ?? "");
    if (problem) return err(reply, 400, problem);
    if (store.findUser(body.username)) return err(reply, 409, `user ${body.username} already exists`);
    const user = store.createUser(body.username, await hashPassword(body.password), body.role);
    controller.note("info", `${req.user!.username} created ${user.role} ${user.username}`);
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
