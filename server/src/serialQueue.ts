/**
 * Runs async tasks strictly one after another.
 *
 * The controller awaits simulator commands in the middle of handling an event; without
 * this, a second webhook could start being handled at that await and see half-updated
 * state. Every event, tick and resync goes through one queue, so handlers never
 * interleave - the same guarantee the event loop gives synchronous code.
 */
export type Task = () => Promise<void> | void;

export interface TaskQueue {
  push(task: Task): void;
}

export class SerialQueue implements TaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (err: unknown) => void) {}

  push(task: Task): void {
    this.pending++;
    this.tail = this.tail
      .then(task)
      .catch(this.onError)
      .finally(() => { this.pending--; });
  }

  get depth(): number {
    return this.pending;
  }

  /** Resolves once everything queued so far has run (tests, shutdown). */
  idle(): Promise<void> {
    return this.tail;
  }
}
