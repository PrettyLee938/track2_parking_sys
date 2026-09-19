import type { FastifyInstance } from "fastify";
import type { LoginRequest, MeResponse } from "@gpa/shared";
import type { RouteDeps, Guards } from "./context";
import { SESSION_COOKIE, cookies, err, jsonBody, setSessionCookie } from "./context";

export function registerAuth(app: FastifyInstance, deps: RouteDeps, guards: Guards): void {
  app.post("/api/auth/login", async (req, reply) => {
    const body = jsonBody<LoginRequest>(req);
    if (!body?.username || !body?.password) return err(reply, 400, "username and password are required");
    const result = await deps.auth.login(String(body.username), String(body.password));
    if (!result.ok) {
      if (result.reason === "throttled") { reply.header("retry-after", String(result.retryAfterS)); return err(reply, 429, `too many failed attempts - try again in ${result.retryAfterS}s`); }
      return err(reply, 401, "wrong username or password");
    }
    setSessionCookie(reply, result.token, deps.cfg.sessionTtlH * 3600);
    req.log.warn(`sign-in: ${result.user.username} (${result.user.role})`);
    return { user: result.user } satisfies MeResponse;
  });
  app.post("/api/auth/logout", async (req, reply) => {
    deps.auth.logout(cookies(req)[SESSION_COOKIE]); setSessionCookie(reply, "", 0); return { ok: true };
  });
  app.get("/api/auth/me", guards.operator, async (req): Promise<MeResponse> => ({ user: req.user! }));
}
