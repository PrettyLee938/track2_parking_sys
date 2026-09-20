/**
 * Runs async tasks strictly one after another.
 *
 * The controller awaits simulator commands in the middle of handling an event; without
 * this, a second webhook could start being handled at that await and see half-updated
 * state. Every event, tick, resync and manual command goes through one queue, so
 * handlers never interleave - the same guarantee the event loop gives synchronous code.
 *
 * It is also the only thing standing between us and a burst: Level 3 runs three car
 * emitters, so "everyone leaves at once" is normal traffic. Nothing is dropped (the queue
 * is unbounded and every delivery is already persisted before it is queued), but a handler
 * that is too slow shows up as a growing backlog. stats() measures exactly that - depth,
 * how long the oldest waiting task has waited, and per-handler durations - so the
 * dashboard and the load test can see it instead of guessing.
 */
import type { QueueStats } from "@gpa/shared";

export type Task = () => Promise<void> | void;

export interface TaskQueue {
  /** Fire and forget. The label is only used for instrumentation. */
  push(task: Task, label?: string): void;
  /** Run in turn and hand back the result (manual commands from the dashboard). */
  run<T>(fn: () => Promise<T> | T, label?: string): Promise<T>;
  /** Live queue health, when the implementation measures it. */
  stats?(): QueueStats;
}

interface Waiting {
  label: string;
  /** performance.now() when it was queued. */
  at: number;
}

/** Durations kept for the rolling average/p95. Small: this is read once a second. */
const SAMPLES = 200;

export class SerialQueue implements TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** In queue order, so waiting[0] is the one that has waited longest. */
  private readonly waiting: Waiting[] = [];
  private running: Waiting | null = null;
  private runningSince = 0;
  private completed = 0;
  private failed = 0;
  private lastMs = 0;
  private readonly samples: { label: string; ms: number }[] = [];

  constructor(private readonly onError: (err: unknown) => void) {}

  push(task: Task, label = "task"): void {
    this.run(task, label).catch(this.onError);
  }

  run<T>(fn: () => Promise<T> | T, label = "task"): Promise<T> {
    const entry: Waiting = { label, at: performance.now() };
    this.waiting.push(entry);
    const result = this.tail.then(() => {
      this.waiting.shift(); // strictly FIFO: this task is always the head
      this.running = entry;
      this.runningSince = performance.now();
      return fn();
    });
    this.tail = result.then(() => this.finished(entry, true), (err) => { this.finished(entry, false); throw err; })
      .catch(() => undefined);
    return result;
  }

  private finished(entry: Waiting, ok: boolean) {
    // Only count the task we actually started: a rejection that never ran (impossible
    // today, but cheap to be right about) must not skew the durations.
    if (this.running !== entry) return;
    this.lastMs = performance.now() - this.runningSince;
    this.samples.push({ label: entry.label, ms: this.lastMs });
    if (this.samples.length > SAMPLES) this.samples.shift();
    if (ok) this.completed++;
    else this.failed++;
    this.running = null;
  }

  /** Tasks queued and not finished, including the one running. */
  get depth(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  stats(): QueueStats {
    const now = performance.now();
    const sorted = this.samples.map((s) => s.ms).sort((a, b) => a - b);
    const slowest = this.samples.reduce<{ label: string; ms: number } | null>((m, s) => (!m || s.ms > m.ms ? s : m), null);
    const head = this.waiting[0];
    return {
      depth: this.depth,
      running: this.running?.label ?? null,
      running_ms: this.running ? round(now - this.runningSince) : 0,
      oldest_wait_ms: head ? round(now - head.at) : 0,
      oldest_label: head?.label ?? null,
      completed: this.completed,
      failed: this.failed,
      last_ms: round(this.lastMs),
      avg_ms: sorted.length ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      p95_ms: sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]) : 0,
      max_ms: round(slowest?.ms ?? 0),
      slowest: slowest?.label ?? null,
    };
  }

  /** Resolves once everything queued so far has run (tests, shutdown). */
  idle(): Promise<unknown> {
    return this.tail;
  }
}

const round = (ms: number) => Math.round(ms * 10) / 10;
