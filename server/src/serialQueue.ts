/**
 * Runs async tasks strictly one after another.
 *
 * The controller awaits simulator commands in the middle of handling an event; without
 * this, a second webhook could start being handled at that await and see half-updated
 * state. Every event, tick, resync and manual command goes through one queue, so
 * handlers never interleave - the same guarantee the event loop gives synchronous code.
 */
export type Task = () => Promise<void> | void;

export interface TaskQueue {
  /** Fire and forget. */
  push(task: Task): void;
  /** Run in turn and hand back the result (manual commands from the dashboard). */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
}

export class SerialQueue implements TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (err: unknown) => void) {}

  push(task: Task): void {
    this.run(task).catch(this.onError);
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.pending++;
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined).finally(() => { this.pending--; });
    return result;
  }

  get depth(): number {
    return this.pending;
  }

  /** Resolves once everything queued so far has run (tests, shutdown). */
  idle(): Promise<unknown> {
    return this.tail;
  }
}
