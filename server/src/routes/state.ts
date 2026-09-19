import type { FastifyInstance } from "fastify";
import type { StateSnapshot, StatsResponse, TimeseriesResponse } from "@gpa/shared";
import type { RouteDeps, Guards } from "./context";
import { BUCKETS_S, cookies, SESSION_COOKIE } from "./context";

export function registerState(app: FastifyInstance, deps: RouteDeps, guards: Guards): void {
  app.get("/api/state", guards.operator, async (): Promise<StateSnapshot> => deps.controller.snapshot());
  app.get("/api/stream", guards.operator, (req, reply) => {
    const token = cookies(req)[SESSION_COOKIE]; reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = () => res.write(`data: ${JSON.stringify(deps.controller.snapshot())}\n\n`);
    send();
    const timer = setInterval(() => {
      if (!deps.auth.userForToken(token)) { res.write("event: signedout\ndata: {}\n\n"); clearInterval(timer); res.end(); return; }
      send();
    }, deps.cfg.streamIntervalS * 1000);
    req.raw.on("close", () => clearInterval(timer));
  });
  app.get("/api/timeseries", guards.operator, async (): Promise<TimeseriesResponse> =>
    ({ sample_s: deps.cfg.statsSampleS, points: deps.controller.timeseries }));
  app.get<{ Querystring: { minutes?: string } }>("/api/stats", guards.operator, async (req): Promise<StatsResponse> => {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 7 * 24 * 60);
    const bucket = BUCKETS_S.find((size) => (minutes * 60) / size <= 40) ?? BUCKETS_S.at(-1)!;
    const until = Date.now(); return deps.store.stats(until - minutes * 60_000, until, bucket);
  });
}
