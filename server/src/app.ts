/**
 * HTTP routes: webhook intake, the dashboard's read API, and debug endpoints.
 *
 *   POST /webhook        simulator -> us
 *   GET  /api/state      everything the dashboard needs in one call (StateSnapshot)
 *   GET  /api/sessions   finished visits from the database (?plate=&since=&until=&limit=)
 *   POST /api/resync     re-read spots and gates (costly: after a crash or level change)
 *   GET  /debug/stats | /debug/recent?n= | /debug/config
 */
import type { FastifyInstance } from "fastify";
import type { SessionsResponse, StateSnapshot } from "@gpa/shared";
import type { Settings } from "./config";
import type { Controller } from "./controller";
import type { EventRecord, Store } from "./store";
import { Intake, parseRaw } from "./webhook";

export interface AppDeps {
  cfg: Settings;
  controller: Controller;
  store: Store;
  intake?: Intake;
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { cfg, controller, store } = deps;
  const intake = deps.intake ?? new Intake(cfg.requireSignature);
  const recent: EventRecord[] = [];

  // Fastify logs every request at info level; one line per webhook is noise. Routes log
  // at warn (handlers here only log warnings and errors).
  app.addHook("onRoute", (route) => {
    route.logLevel = "warn";
  });

  // The webhook needs the raw body: Fastify's JSON parser would turn 1.0 into 1 before
  // the signature is checked. Accept any content type the simulator might send.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

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
  // read API (dashboard)
  // ---------------------------------------------------------------------------
  app.get("/api/state", async (): Promise<StateSnapshot> => controller.snapshot());

  app.get<{ Querystring: { plate?: string; since?: string; until?: string; limit?: string } }>(
    "/api/sessions",
    async (req): Promise<SessionsResponse> => ({
      items: store.searchSessions({ ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined }),
    }),
  );

  app.post("/api/resync", async () => {
    controller.requestResync();
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // debug (used by tools/)
  // ---------------------------------------------------------------------------
  app.get("/debug/stats", async () => ({
    ...intake.stats, last_sequence_id: intake.lastSeq, controller_enabled: cfg.controllerEnabled,
  }));

  app.get<{ Querystring: { n?: string } }>("/debug/recent", async (req) => recent.slice(-(Number(req.query.n) || 20)));

  app.get("/debug/config", async () => ({ ...cfg, simPassword: "***" }));
}
