import type { FastifyInstance, FastifyReply } from "fastify";
import type { ControlResult, GateAction } from "@gpa/shared";
import type { RouteDeps, Guards } from "./context";
import { GATE_ACTIONS, err } from "./context";

const control = async (reply: FastifyReply, run: () => Promise<ControlResult>) => {
  const result = await run(); return reply.code(result.ok ? 200 : 409).send(result);
};

export function registerControl(app: FastifyInstance, deps: RouteDeps, guards: Guards): void {
  app.post<{ Params: { name: string; action: string } }>("/api/control/gates/:name/:action", guards.operator, async (req, reply) => {
    const action = req.params.action as GateAction;
    if (!GATE_ACTIONS.includes(action)) return err(reply, 400, `action must be one of ${GATE_ACTIONS.join(", ")}`);
    return control(reply, () => deps.controller.exclusive(() => deps.controller.manualGate(req.params.name, action, req.user!.username)));
  });
  app.post<{ Params: { name: string } }>("/api/control/spots/:name/repair", guards.operator, async (req, reply) =>
    control(reply, () => deps.controller.exclusive(() => deps.controller.manualSpotRepair(req.params.name, req.user!.username))));
  app.post<{ Params: { spot: string; state: string } }>("/api/control/entries/:spot/:state", guards.admin, async (req, reply) => {
    if (req.params.state !== "open" && req.params.state !== "close") return err(reply, 400, "state must be open or close");
    return control(reply, () => deps.controller.exclusive(() => deps.controller.setEntryOpen(req.params.spot, req.params.state === "open", req.user!.username)));
  });
  app.post("/api/resync", guards.admin, async (req) => {
    deps.controller.requestResync(); deps.controller.note("info", `${req.user!.username} requested a resync`);
    return { ok: true, message: "resync queued" } satisfies ControlResult;
  });
}
