import type { FastifyInstance } from "fastify";
import { AuthService } from "./auth";
import type { Settings } from "./config";
import type { Controller } from "./controller";
import type { EventRecord, Store } from "./store";
import { Intake } from "./webhook";
import { cookies, guards, SESSION_COOKIE, type RouteDeps } from "./routes/context";
import { registerAdmin } from "./routes/admin";
import { registerAuth } from "./routes/auth";
import { registerControl } from "./routes/control";
import { registerDebug } from "./routes/debug";
import { registerLogs } from "./routes/logs";
import { registerState } from "./routes/state";
import { registerWebhook } from "./routes/webhook";

export interface AppDeps {
  cfg: Settings;
  controller: Controller;
  store: Store;
  auth: AuthService;
  intake?: Intake;
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const routeDeps: RouteDeps = {
    ...deps,
    intake: deps.intake ?? new Intake(deps.cfg.requireSignature),
    recent: [] as EventRecord[],
  };
  app.addHook("onRoute", (route) => { route.logLevel = "warn"; });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => { req.user = routeDeps.auth.userForToken(cookies(req)[SESSION_COOKIE]); });

  const access = guards(routeDeps.auth);
  registerWebhook(app, routeDeps);
  registerAuth(app, routeDeps, access);
  registerState(app, routeDeps, access);
  registerLogs(app, routeDeps, access);
  registerControl(app, routeDeps, access);
  registerAdmin(app, routeDeps, access);
  registerDebug(app, routeDeps, access);
}
