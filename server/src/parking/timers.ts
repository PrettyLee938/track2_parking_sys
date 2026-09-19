import type { TaskQueue } from "../serialQueue";
import type { Callback, Timer } from "./state";

export interface TimerContext {
  readonly replaying: boolean;
  readonly started: boolean;
  readonly queue: TaskQueue;
  timers: Timer[];
}

export function later(ctx: TimerContext, delaySeconds: number, label: string, callback: Callback): void {
  if (ctx.replaying) return;
  const timer: Timer = { due: Date.now() / 1000 + delaySeconds, label, fn: callback, done: false };
  ctx.timers.push(timer);
  if (ctx.started) setTimeout(() => ctx.queue.push(() => runTimer(ctx, timer)), delaySeconds * 1000);
}

export async function runDueTimers(ctx: TimerContext, now: number): Promise<void> {
  for (const timer of ctx.timers.filter((candidate) => candidate.due <= now)) await runTimer(ctx, timer);
}

async function runTimer(ctx: TimerContext, timer: Timer): Promise<void> {
  if (timer.done) return;
  timer.done = true;
  ctx.timers = ctx.timers.filter((candidate) => candidate !== timer);
  await timer.fn();
}
