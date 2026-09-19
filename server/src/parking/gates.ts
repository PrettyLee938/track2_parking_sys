import { ComponentType, GateState, type Counters, type FeedLevel } from "@gpa/shared";
import type { Settings } from "../config";
import type { EventRecord } from "../store";
import { command } from "./commands";
import { nowSeconds } from "./clock";
import { Gate, type Callback, type EntryLane, type ExitLane } from "./state";
import type { SimApi } from "../simClient";
import type { Spot } from "./state";

export interface GateContext {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly store: { recordAction(action: { at: string; cmd: string; args: string[]; ok: boolean; error: string | null; ms: number; actor?: string | null }): void };
  readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  readonly replaying: boolean;
  counters: Counters;
  feed: { at: string; level: FeedLevel; msg: string }[];
  gates: Map<string, Gate>;
  entryLanes: Map<string, EntryLane>;
  exitLanes: Map<string, ExitLane>;
  spots: Map<string, Spot>;
  real(gameSeconds: number): number;
  note(level: FeedLevel, message: string): void;
  pumpEntry(lane: EntryLane): Promise<void>;
}

export async function onGate(ctx: GateContext, event: EventRecord): Promise<void> {
  const name = String(event.Name ?? "");
  const gate = ctx.gates.get(name) ?? new Gate(name, "");
  ctx.gates.set(name, gate);
  gate.state = String(event.Action ?? "");
  if (gate.state === GateState.Open) await gateOpened(ctx, gate);
  else if (gate.state === GateState.Closed && gate.onOpen.length && gate.hold !== "closed") await requestGateOpen(ctx, gate);
}

async function gateOpened(_ctx: GateContext, gate: Gate): Promise<void> {
  gate.openRequestedAt = null;
  gate.openRetries = 0;
  const callbacks = gate.onOpen;
  gate.onOpen = [];
  for (const callback of callbacks) await callback();
}

export async function whenGateOpen(ctx: GateContext, gate: Gate, callback: Callback): Promise<void> {
  if (gate.state === GateState.Open) {
    await callback();
    return;
  }
  gate.onOpen.push(callback);
  if (gate.hold === "closed") return;
  if (gate.state !== GateState.Opening) await requestGateOpen(ctx, gate);
  else if (gate.openRequestedAt === null) gate.openRequestedAt = nowSeconds();
}

export async function requestGateOpen(ctx: GateContext, gate: Gate): Promise<void> {
  if (await command(ctx, "open", () => ctx.sim.openGate(gate.name), [gate.name])) {
    gate.state = GateState.Opening;
    gate.openRequestedAt = nowSeconds();
  }
}

export async function checkGateTimeouts(ctx: GateContext, now: number): Promise<void> {
  for (const gate of ctx.gates.values()) {
    if (!gate.onOpen.length || gate.openRequestedAt === null) continue;
    if (now - gate.openRequestedAt < ctx.real(ctx.cfg.gateOpenTimeoutGameS)) continue;
    if (gate.openRetries === 0) {
      gate.openRetries = 1;
      ctx.note("warn", `${gate.name} did not confirm opening, re-sending open`);
      await requestGateOpen(ctx, gate);
    } else {
      ctx.note("warn", `${gate.name} still unconfirmed, assuming it is open`);
      gate.state = GateState.Open;
      await gateOpened(ctx, gate);
    }
  }
}

export function gateBusy(ctx: GateContext, name: string): boolean {
  return [...ctx.entryLanes.values()].some((lane) => lane.gate === name && (lane.current || lane.queue.length)) ||
    [...ctx.exitLanes.values()].some((lane) => lane.gate === name && lane.releasing.size > 0);
}

export async function closeGateIfIdle(ctx: GateContext, name: string | null): Promise<void> {
  const gate = name ? ctx.gates.get(name) : undefined;
  if (!gate || !gate.operable || gate.hold === "open" || gateBusy(ctx, gate.name) || gate.onOpen.length) return;
  if (gate.state !== GateState.Open && gate.state !== GateState.Opening) return;
  if (await command(ctx, "close", () => ctx.sim.closeGate(gate.name), [gate.name])) gate.state = GateState.Closing;
}

export async function onComponent(ctx: GateContext, event: EventRecord, broken: boolean): Promise<void> {
  const name = String(event.Name ?? "");
  const kind = String(event.Type ?? "");
  const target = kind === ComponentType.BarrierGate ? ctx.gates.get(name) : ctx.spots.get(name);
  if (target) {
    target.broken = broken;
    if (!broken) target.maintenance = false;
  }
  ctx.note(broken ? "error" : "info", `${kind} ${name} ${broken ? "BROKEN" : "fixed"}`);
  if (!broken) for (const lane of ctx.entryLanes.values()) await ctx.pumpEntry(lane);
}
