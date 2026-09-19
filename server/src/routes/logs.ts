import type { FastifyInstance } from "fastify";
import type { ActionsResponse, EventsResponse, SessionsResponse } from "@gpa/shared";
import type { RouteDeps, Guards } from "./context";

type ListQuery = { plate?: string; status?: string; class?: string; since?: string; until?: string; limit?: string; before?: string };
const num = (value?: string) => value ? Number(value) || undefined : undefined;

export function registerLogs(app: FastifyInstance, deps: RouteDeps, guards: Guards): void {
  app.get<{ Querystring: ListQuery }>("/api/sessions", guards.operator, async (req): Promise<SessionsResponse> => ({
    items: deps.store.searchSessions({ plate: req.query.plate, status: req.query.status, since: req.query.since,
      until: req.query.until, limit: num(req.query.limit), beforeId: num(req.query.before) }),
  }));
  app.get<{ Querystring: ListQuery }>("/api/events", guards.operator, async (req): Promise<EventsResponse> => ({
    items: deps.store.searchEvents({ plate: req.query.plate, eventClass: req.query.class, since: req.query.since,
      until: req.query.until, limit: num(req.query.limit), beforeId: num(req.query.before) }),
  }));
  app.get<{ Querystring: { manual?: string; limit?: string } }>("/api/actions", guards.operator, async (req): Promise<ActionsResponse> => ({
    items: deps.store.searchActions({ manualOnly: req.query.manual === "1", limit: num(req.query.limit) }),
  }));
}
