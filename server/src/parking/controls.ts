import { GateState, SpotPurpose, type ControlResult, type GateAction } from "@gpa/shared";
import type { Settings } from "../config";
import { command } from "./commands";
import { closeGateIfIdle, gateBusy, requestGateOpen } from "./gates";
import { Gate, Spot, type EntryLane } from "./state";
import type { SimApi } from "../simClient";
import type { GateContext } from "./gates";

export interface ControlContext extends GateContext {
  readonly cfg: Settings;
  readonly sim: SimApi;
  gates: Map<string, Gate>;
  spots: Map<string, Spot>;
  entryLanes: Map<string, EntryLane>;
}

const ok = (message: string): ControlResult => ({ ok: true, message });
const fail = (message: string): ControlResult => ({ ok: false, message });

export async function manualGate(ctx: ControlContext, name: string, action: GateAction, actor: string): Promise<ControlResult> {
  const gate = ctx.gates.get(name);
  if (!gate) return fail(`unknown gate ${name}`);
  const unusable = gate.broken ? "broken" : gate.maintenance ? "under maintenance" : null;
  const inUse = gateBusy(ctx, name) || gate.onOpen.length > 0;
  switch (action) {
    case "open":
    case "close": {
      if (unusable) return fail(`${name} is ${unusable} - operating it now is a penalty`);
      if (action === "close" && inUse) return fail(`${name} is letting a car through right now - try again in a moment`);
      gate.hold = action === "open" ? "open" : "closed";
      const sent = action === "open"
        ? await command(ctx, "open", () => ctx.sim.openGate(name), [name], actor)
        : await command(ctx, "close", () => ctx.sim.closeGate(name), [name], actor);
      if (!sent) { gate.hold = null; return fail(`the simulator rejected ${action} ${name}`); }
      if (action === "open" && gate.state !== GateState.Open) gate.state = GateState.Opening;
      if (action === "close") gate.state = GateState.Closing;
      ctx.note("warn", `${actor} holds ${name} ${gate.hold}`);
      return ok(`${name} held ${gate.hold} until returned to automatic`);
    }
    case "auto":
      gate.hold = null;
      if (gate.onOpen.length && gate.operable) await requestGateOpen(ctx, gate);
      else await closeGateIfIdle(ctx, name);
      ctx.note("info", `${actor} returned ${name} to automatic`);
      return ok(`${name} is automatic again`);
    case "repair":
      if (gate.maintenance) return fail(`${name} is already under maintenance`);
      if (inUse) return fail(`${name} is in use - repairing it now is a penalty`);
      if (!(await command(ctx, "repair", () => ctx.sim.repairGate(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
      gate.maintenance = true;
      ctx.note("warn", `${actor} started maintenance on ${name}`);
      return ok(`maintenance started on ${name}`);
  }
}

export async function manualSpotRepair(ctx: ControlContext, name: string, actor: string): Promise<ControlResult> {
  const spot = ctx.spots.get(name);
  if (!spot || spot.purpose !== SpotPurpose.Park) return fail(`unknown parking spot ${name}`);
  if (spot.maintenance) return fail(`${name} is already under maintenance`);
  const who = spot.occupant ?? spot.reserved_for;
  if (who) return fail(`${name} is ${spot.occupant ? "occupied" : "reserved"}${who !== "?" ? ` by ${who}` : ""} - repairing it now is a penalty`);
  if (!(await command(ctx, "repair", () => ctx.sim.repairSpot(name), [name], actor))) return fail(`the simulator rejected repair ${name}`);
  spot.maintenance = true;
  ctx.note("warn", `${actor} started maintenance on ${name}`);
  return ok(`maintenance started on ${name}`);
}

export async function setEntryOpen(ctx: ControlContext, spot: string, open: boolean, actor: string): Promise<ControlResult> {
  const lane = ctx.entryLanes.get(spot);
  if (!lane) return fail(`unknown entrance ${spot}`);
  lane.closed = !open;
  ctx.note("warn", `${actor} ${open ? "reopened" : "closed"} entrance ${spot}`);
  if (open) await ctx.pumpEntry(lane);
  return ok(`entrance ${spot} ${open ? "open" : "closed - arriving cars are turned away"}`);
}
