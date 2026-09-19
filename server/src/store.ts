/**
 * Persistence (SQLite via better-sqlite3).
 *
 *   events   - every webhook received, with intake metadata (signature, duplicate...)
 *   sessions - one row per finished car visit: plate, lanes, spot, times, charge, payment
 *   actions  - every command we sent to the simulator, and whether it succeeded
 *
 * Writes are synchronous and take microseconds, so they never hold up event handling.
 * The database workstream can extend the schema here; the rest of the app only uses
 * the Store methods.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SessionView, SimEventBase } from "@gpa/shared";

/** A received webhook as the controller sees it: the payload plus intake metadata. */
export type EventRecord = SimEventBase & {
  _received_at: string;
  _sig?: string;
  _duplicate?: boolean;
  _seq_note?: string;
  _accepted?: boolean;
};

export interface ActionRecord {
  at: string;
  cmd: string;
  args: string[];
  ok: boolean;
  error: string | null;
  ms: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  event_id     TEXT,
  seq          INTEGER,
  event_class  TEXT NOT NULL,
  plate        TEXT,
  spot         TEXT,
  received_at  TEXT NOT NULL,
  received_ms  INTEGER NOT NULL,
  sig          TEXT,
  accepted     INTEGER NOT NULL,
  duplicate    INTEGER NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_received ON events (received_ms);
CREATE INDEX IF NOT EXISTS events_plate    ON events (plate, received_ms);
CREATE INDEX IF NOT EXISTS events_class    ON events (event_class, received_ms);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY,
  plate            TEXT NOT NULL,
  car_type         TEXT,
  status           TEXT NOT NULL,
  entry_lane       TEXT,
  exit_lane        TEXT,
  spot             TEXT,
  planned_minutes  INTEGER,
  arrived_at       TEXT,
  parked_at        TEXT,
  left_spot_at     TEXT,
  exit_at          TEXT,
  left_at          TEXT,
  parked_seconds   REAL,
  charge_parking   REAL,
  charge_electric  REAL,
  charge_attempts  INTEGER,
  paid             REAL,
  payment_ok       INTEGER,
  recorded_at      TEXT NOT NULL,
  data             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_plate    ON sessions (plate, recorded_at);
CREATE INDEX IF NOT EXISTS sessions_recorded ON sessions (recorded_at);

CREATE TABLE IF NOT EXISTS actions (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  cmd    TEXT NOT NULL,
  args   TEXT NOT NULL,
  ok     INTEGER NOT NULL,
  error  TEXT,
  ms     REAL
);
CREATE INDEX IF NOT EXISTS actions_at ON actions (at);
`;

export class Store {
  readonly db: Database.Database;
  private readonly insEvent;
  private readonly insSession;
  private readonly insAction;

  /** dataDir, or ":memory:" for tests. */
  constructor(dataDir: string) {
    if (dataDir === ":memory:") {
      this.db = new Database(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new Database(path.join(dataDir, "gpa.db"));
      this.db.pragma("journal_mode = WAL");
    }
    this.db.exec(SCHEMA);
    this.insEvent = this.db.prepare(`
      INSERT INTO events (event_id, seq, event_class, plate, spot, received_at, received_ms, sig, accepted, duplicate, payload)
      VALUES (@event_id, @seq, @event_class, @plate, @spot, @received_at, @received_ms, @sig, @accepted, @duplicate, @payload)`);
    this.insSession = this.db.prepare(`
      INSERT INTO sessions (plate, car_type, status, entry_lane, exit_lane, spot, planned_minutes, arrived_at, parked_at,
        left_spot_at, exit_at, left_at, parked_seconds, charge_parking, charge_electric, charge_attempts, paid, payment_ok,
        recorded_at, data)
      VALUES (@plate, @car_type, @status, @entry_lane, @exit_lane, @spot, @planned_minutes, @arrived_at, @parked_at,
        @left_spot_at, @exit_at, @left_at, @parked_seconds, @charge_parking, @charge_electric, @charge_attempts, @paid,
        @payment_ok, @recorded_at, @data)`);
    this.insAction = this.db.prepare(
      `INSERT INTO actions (at, cmd, args, ok, error, ms) VALUES (@at, @cmd, @args, @ok, @error, @ms)`);
  }

  recordEvent(r: EventRecord): void {
    const { _received_at, _sig, _duplicate, _accepted, _seq_note, ...payload } = r;
    const seq = Number(payload.SequenceId);
    this.insEvent.run({
      event_id: payload.EventId ?? null,
      seq: Number.isFinite(seq) ? seq : null,
      event_class: payload.EventClass ?? "?",
      plate: (payload.CarPlateNumber as string | undefined) ?? null,
      spot: (payload.SpotName as string | undefined) ?? null,
      received_at: _received_at,
      received_ms: Date.parse(_received_at),
      sig: _sig ?? null,
      accepted: _accepted === false ? 0 : 1,
      duplicate: _duplicate ? 1 : 0,
      payload: JSON.stringify(payload),
    });
  }

  recordSession(s: SessionView): void {
    this.insSession.run({
      ...s,
      payment_ok: s.payment_ok === null ? null : s.payment_ok ? 1 : 0,
      recorded_at: new Date().toISOString(),
      data: JSON.stringify(s),
    });
  }

  recordAction(a: ActionRecord): void {
    this.insAction.run({ ...a, args: JSON.stringify(a.args), ok: a.ok ? 1 : 0 });
  }

  /** Accepted events received since sinceMs, oldest first - for startup replay. */
  eventsSince(sinceMs: number): EventRecord[] {
    const rows = this.db.prepare(
      `SELECT payload, received_at, sig FROM events WHERE accepted = 1 AND received_ms >= ? ORDER BY id`,
    ).all(sinceMs) as { payload: string; received_at: string; sig: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.payload), _received_at: r.received_at, _sig: r.sig, _accepted: true }));
  }

  /** Finished sessions, newest first, optionally filtered by (partial) plate and time. */
  searchSessions(opts: { plate?: string; since?: string; until?: string; limit?: number }) {
    const where: string[] = [], params: Record<string, unknown> = { limit: Math.min(opts.limit ?? 100, 1000) };
    if (opts.plate) { where.push("plate LIKE @plate"); params.plate = `%${opts.plate}%`; }
    if (opts.since) { where.push("recorded_at >= @since"); params.since = opts.since; }
    if (opts.until) { where.push("recorded_at <= @until"); params.until = opts.until; }
    const rows = this.db.prepare(
      `SELECT id, recorded_at, data FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY id DESC LIMIT @limit`,
    ).all(params) as { id: number; recorded_at: string; data: string }[];
    return rows.map((r) => ({ id: r.id, recorded_at: r.recorded_at, ...JSON.parse(r.data) }));
  }

  close(): void {
    this.db.close();
  }
}
