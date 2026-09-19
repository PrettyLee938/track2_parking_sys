import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { REPO_ROOT } from "../config";
import type { RouteDeps, Guards } from "./context";

export function registerDebug(app: FastifyInstance, deps: RouteDeps, guards: Guards): void {
  app.get("/debug/stats", guards.debugAccess, async () => ({
    ...deps.intake.stats, last_sequence_id: deps.intake.lastSeq, controller_enabled: deps.cfg.controllerEnabled,
  }));
  app.get<{ Querystring: { n?: string } }>("/debug/recent", guards.debugAccess, async (req) => deps.recent.slice(-(Number(req.query.n) || 20)));
  app.get("/debug/config", guards.debugAccess, async () => ({ ...deps.cfg, simPassword: "***", adminPassword: deps.cfg.adminPassword ? "***" : undefined }));
  const dist = path.join(REPO_ROOT, "web", "dist");
  if (!existsSync(path.join(dist, "index.html"))) return;
  const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
  app.get("/*", async (req, reply) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, ""), file = path.resolve(dist, rel);
    const inside = file.startsWith(dist + path.sep);
    const target = inside && existsSync(file) && !file.endsWith(path.sep) && path.extname(file) ? file : path.join(dist, "index.html");
    return reply.type(types[path.extname(target)] ?? "application/octet-stream").send(readFileSync(target));
  });
}
