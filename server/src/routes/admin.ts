import type { FastifyInstance } from "fastify";
import type { CreateUserRequest, MeResponse, UpdateUserRequest, UsersResponse } from "@gpa/shared";
import { hashPassword, validateCredentials } from "../auth";
import type { RouteDeps, Guards } from "./context";
import { err, jsonBody } from "./context";

export function registerAdmin(app: FastifyInstance, deps: RouteDeps, guards: Guards): void {
  app.get("/api/config", guards.admin, async () => ({ ...deps.cfg, simPassword: "***", adminPassword: deps.cfg.adminPassword ? "***" : undefined }));
  app.get("/api/users", guards.admin, async (): Promise<UsersResponse> => ({ items: deps.store.listUsers() }));
  app.post("/api/users", guards.admin, async (req, reply) => {
    const body = jsonBody<CreateUserRequest>(req);
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== "admin" && body.role !== "operator") return err(reply, 400, "role must be admin or operator");
    const problem = validateCredentials(body.username ?? "", body.password ?? "");
    if (problem) return err(reply, 400, problem);
    if (deps.store.findUser(body.username)) return err(reply, 409, `user ${body.username} already exists`);
    const user = deps.store.createUser(body.username, await hashPassword(body.password), body.role);
    deps.controller.note("info", `${req.user!.username} created ${user.role} ${user.username}`);
    return reply.code(201).send({ user } satisfies MeResponse);
  });
  app.patch<{ Params: { id: string } }>("/api/users/:id", guards.admin, async (req, reply) => {
    const id = Number(req.params.id), target = deps.store.getUser(id), body = jsonBody<UpdateUserRequest>(req);
    if (!target) return err(reply, 404, "no such user");
    if (!body) return err(reply, 400, "invalid JSON");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "operator") return err(reply, 400, "role must be admin or operator");
    if (body.password !== undefined) { const problem = validateCredentials(undefined, body.password); if (problem) return err(reply, 400, problem); }
    const losesAdmin = target.role === "admin" && (body.role === "operator" || body.disabled === true);
    if (losesAdmin && deps.store.countOtherActiveAdmins(id) === 0) return err(reply, 409, "cannot remove the last active admin");
    if (id === req.user!.id && body.disabled === true) return err(reply, 409, "you cannot disable your own account");
    const user = deps.store.updateUser(id, { role: body.role, disabled: body.disabled,
      passwordHash: body.password !== undefined ? await hashPassword(body.password) : undefined })!;
    if (body.password !== undefined || body.role !== undefined || body.disabled) deps.auth.revokeAll(id);
    const what = [body.role && `role ${body.role}`, body.disabled !== undefined && (body.disabled ? "disabled" : "enabled"), body.password !== undefined && "password reset"].filter(Boolean).join(", ");
    deps.controller.note("info", `${req.user!.username} updated ${user.username}: ${what}`);
    return { user } satisfies MeResponse;
  });
}
