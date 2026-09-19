import { Direction, EventClass, SpotPurpose } from "@gpa/shared";
import type { Settings } from "../config";
import type { EventRecord } from "../store";
import { onComponent, onGate } from "./gates";
import { onEntryIn, onEntryOut, onSpotIn, onSpotOut } from "./entryFlow";
import { onExitIn, onExitOut, onPayment } from "./exitFlow";
import { onPenalty } from "./penalties";
import type { EntryContext } from "./entryFlow";
import type { ExitContext } from "./exitFlow";
import type { GateContext } from "./gates";
import type { PenaltyContext } from "./penalties";

const field = (event: EventRecord, key: string) => event[key] as string | undefined;

export type EventContext = EntryContext & ExitContext & GateContext & PenaltyContext & {
  replayedIds: Set<string>;
  lastResyncRequest: number;
  unresolvedSpots: Map<string, number>;
  lastEventReal: number | null;
  requestResync(): void;
  sync(): Promise<void>;
};

export async function handleEvent(ctx: EventContext, event: EventRecord): Promise<void> {
  const eventId = event.EventId;
  if (ctx.replaying) {
    if (eventId) ctx.replayedIds.add(eventId);
  } else {
    if (eventId && ctx.replayedIds.has(eventId)) return;
    const now = Date.now() / 1000;
    if (ctx.lastEventReal && now - ctx.lastEventReal > ctx.real(ctx.cfg.resyncAfterSilenceGameS)) {
      maybeResync(ctx, `no events for ${Math.round(now - ctx.lastEventReal)}s`);
    }
    ctx.lastEventReal = now;
  }
  switch (event.EventClass) {
    case EventClass.CarSpotAction: await routeCarEvent(ctx, event); break;
    case EventClass.GateAction: await onGate(ctx, event); break;
    case EventClass.PaymentMade: await onPayment(ctx, event); break;
    case EventClass.ComponentBroken: await onComponent(ctx, event, true); break;
    case EventClass.ComponentFixed: await onComponent(ctx, event, false); break;
    case EventClass.Penalty: await onPenalty(ctx, event); break;
  }
  const car = ctx.cars.get(field(event, "CarPlateNumber") ?? "");
  if (car) car.lastSeenReal = timestamp(event._received_at) ?? Date.now() / 1000;
}

async function routeCarEvent(ctx: EventContext, event: EventRecord): Promise<void> {
  const name = field(event, "SpotName") ?? "";
  const spotType = field(event, "SpotType");
  const inbound = field(event, "Direction") === Direction.In;
  const entry = ctx.entryLanes.get(name);
  const exit = ctx.exitLanes.get(name);
  if (entry) return inbound ? onEntryIn(ctx, event, entry) : onEntryOut(ctx, event, entry);
  if (exit) return inbound ? onExitIn(ctx, event, exit) : onExitOut(ctx, event, exit);
  if (spotType === SpotPurpose.Park) return inbound ? onSpotIn(ctx, event) : onSpotOut(ctx, event);
  if ((spotType === SpotPurpose.Entry || spotType === SpotPurpose.Exit) && !ctx.replaying) {
    return handleUnknownLaneEvent(ctx, event, name, spotType);
  }
}

async function handleUnknownLaneEvent(ctx: EventContext, event: EventRecord, name: string, spotType: string): Promise<void> {
  const last = ctx.unresolvedSpots.get(name) ?? 0;
  const now = Date.now() / 1000;
  if (now - last < 10) return;
  ctx.unresolvedSpots.set(name, now);
  ctx.note("warn", `event from unknown ${spotType} ${name} - reloading layout now`);
  try {
    await ctx.sync();
  } catch (cause) {
    ctx.note("error", `layout reload failed: ${(cause as Error).message}`);
    return;
  }
  if (ctx.entryLanes.has(name) || ctx.exitLanes.has(name)) {
    ctx.unresolvedSpots.delete(name);
    return routeCarEvent(ctx, event);
  }
  ctx.note("warn", `${spotType} ${name} is not part of the loaded layout - event ignored`);
}

function maybeResync(ctx: EventContext, reason: string): void {
  const now = Date.now() / 1000;
  if (now - ctx.lastResyncRequest <= 10) return;
  ctx.lastResyncRequest = now;
  ctx.note("warn", `${reason} - resyncing`);
  ctx.requestResync();
}

function timestamp(iso?: string | null): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value / 1000;
}
