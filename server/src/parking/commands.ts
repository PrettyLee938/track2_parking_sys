import type { Counters, FeedItem, FeedLevel } from "@gpa/shared";
import type { Settings } from "../config";
import type { ActionRecord, Store } from "../store";
import type { Logger } from "./types";

export interface CommandContext {
  readonly cfg: Pick<Settings, "feedSize">;
  readonly replaying: boolean;
  readonly store: Pick<Store, "recordAction">;
  readonly log: Logger;
  counters: Counters;
  feed: FeedItem[];
}

export async function command(
  ctx: CommandContext,
  name: string,
  run: () => Promise<void>,
  args: (string | number)[],
  actor: string | null = null,
): Promise<boolean> {
  if (ctx.replaying) return true;
  const started = performance.now();
  let ok = true;
  let error: string | null = null;
  try {
    await run();
  } catch (cause) {
    ok = false;
    error = (cause as Error).message ?? String(cause);
    ctx.counters.command_errors++;
    note(ctx, "error", `command ${name}(${args.join(", ")}) failed: ${error}`);
  }
  ctx.store.recordAction({
    at: new Date().toISOString(), cmd: name, args: args.map(String), ok, error,
    ms: Math.round((performance.now() - started) * 10) / 10, actor,
  });
  return ok;
}

export function note(ctx: CommandContext, level: FeedLevel, message: string): void {
  if (ctx.replaying) return;
  ctx.feed.push({ at: new Date().toISOString(), level, msg: message });
  if (ctx.feed.length > ctx.cfg.feedSize) ctx.feed.shift();
  ctx.log[level === "warn" ? "warn" : level === "error" ? "error" : "info"](message);
}
