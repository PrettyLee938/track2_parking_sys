import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiError, GateAction, Role } from "@gpa/shared";
import { AuthService, hasRole } from "../auth";
import type { Settings } from "../config";
import type { Controller } from "../controller";
import type { EventRecord, Store } from "../store";
import type { Intake } from "../webhook";

declare module "fastify" {
  interface FastifyRequest { user: import("@gpa/shared").UserView | null }
}

export interface RouteDeps {
  cfg: Settings;
  controller: Controller;
  store: Store;
  auth: AuthService;
  intake: Intake;
  recent: EventRecord[];
}

export interface Guards {
  operator: { preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  admin: { preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  debugAccess: { preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
}

export const SESSION_COOKIE = "gpa_session";
export const GATE_ACTIONS: GateAction[] = ["open", "close", "auto", "repair"];
export const BUCKETS_S = [60, 120, 300, 600, 900, 1800, 3600];

export function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeS: number): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeS)}`);
}

export const err = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error } satisfies ApiError);

export function jsonBody<T>(req: FastifyRequest): T | null {
  try {
    const parsed = JSON.parse(String(req.body ?? "") || "{}");
    return parsed && typeof parsed === "object" ? parsed as T : null;
  } catch { return null; }
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

export function guards(auth: AuthService): Guards {
  const guard = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return err(reply, 401, "not signed in");
    if (!hasRole(req.user, role)) return err(reply, 403, `requires the ${role} role`);
  };
  return {
    operator: { preHandler: guard("operator") },
    admin: { preHandler: guard("admin") },
    debugAccess: { preHandler: async (req, reply) => {
      if (!isLoopback(req.ip) && !hasRole(req.user, "admin")) return err(reply, 403, "debug endpoints: this machine or an admin only");
    } },
  };
}
