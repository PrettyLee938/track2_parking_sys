import type { Settings } from "../config";
import type { EventRecord } from "../store";
import type { TaskQueue } from "../serialQueue";

export interface LifecycleContext {
  readonly cfg: Settings;
  readonly queue: TaskQueue;
  readonly log: { warn(message: string): void };
  started: boolean;
  stopped: boolean;
  tickHandle: NodeJS.Timeout | null;
  tickPending: boolean;
  synced: boolean;
  sync(options?: { replay?: boolean }): Promise<void>;
  handle(event: EventRecord): Promise<void>;
  tick(): Promise<void>;
}

export function start(ctx: LifecycleContext): void {
  ctx.started = true;
  ctx.queue.push(() => initialSync(ctx));
  ctx.tickHandle = setInterval(() => {
    if (ctx.tickPending) return;
    ctx.tickPending = true;
    ctx.queue.push(async () => {
      ctx.tickPending = false;
      await ctx.tick();
    });
  }, ctx.cfg.tickIntervalS * 1000);
}

export function stop(ctx: LifecycleContext): void {
  ctx.stopped = true;
  if (ctx.tickHandle) clearInterval(ctx.tickHandle);
}

export function submit(ctx: LifecycleContext, event: EventRecord): void {
  ctx.queue.push(() => ctx.handle(event));
}

export function requestResync(ctx: LifecycleContext): void {
  ctx.queue.push(() => ctx.sync());
}

async function initialSync(ctx: LifecycleContext): Promise<void> {
  while (!ctx.stopped && !ctx.synced) {
    try {
      await ctx.sync({ replay: true });
    } catch (error) {
      ctx.log.warn(`sync failed (${(error as Error).message}), retrying in 2s`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
