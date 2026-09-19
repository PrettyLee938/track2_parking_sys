import type { FastifyInstance } from "fastify";
import type { EventRecord } from "../store";
import { parseRaw } from "../webhook";
import type { RouteDeps } from "./context";

export function registerWebhook(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/webhook", async (req) => {
    const receivedAt = new Date().toISOString();
    let event;
    try { event = parseRaw(String(req.body ?? "")); }
    catch { req.log.error({ body: String(req.body).slice(0, 300) }, "non-JSON webhook"); return { ok: false }; }
    const meta = deps.intake.check(event);
    const record: EventRecord = {
      ...event, _received_at: receivedAt, _sig: meta.sig, _duplicate: meta.duplicate,
      _seq_note: meta.seqNote, _accepted: meta.accept,
    };
    deps.store.recordEvent(record);
    deps.recent.push(record);
    if (deps.recent.length > deps.cfg.recentEventsSize) deps.recent.shift();
    if (meta.seqNote) req.log.warn(`sequence gap: ${meta.seqNote}`);
    if (!meta.accept) req.log.warn(`dropped ${event.EventClass} (${meta.duplicate ? "duplicate" : `signature ${meta.sig}`})`);
    else if (deps.cfg.controllerEnabled) deps.controller.submit(record);
    return { ok: true };
  });
}
