/**
 * Persistence (SQLite via better-sqlite3).
 *
 *   events         every webhook received, with intake metadata (signature, duplicate...)
 *   sessions       one row per finished car visit: plate, lanes, spot, times, charge, payment
 *   actions        every command sent to the simulator - by the controller or a named user
 *   users          dashboard accounts (role admin | operator)
 *   auth_sessions  login sessions (only a hash of each token is stored)
 *
 * Writes are synchronous and take microseconds, so they never hold up event handling.
 * Schema changes are applied in migrate() so existing databases keep working.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ActionView, EventView, Role, SessionView, SimEventBase, StatsResponse, UserView } from "@gpa/shared";
import { SCHEMA, migrate } from "./storage/schema";
import { stats as computeStats } from "./storage/stats";
import {
  countOtherActiveAdmins, countUsers, createAuthSession, createUser, deleteAuthSession,
  deleteAuthSessionsForUser, findUser, getUser, listUsers, purgeExpiredAuthSessions,
  touchLogin, updateUser, userForSession, type UserRow,
} from "./storage/users";

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
  actor?: string | null;
}

export type { UserRow } from "./storage/users";

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
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.insEvent = this.db.prepare(`
      INSERT INTO events (event_id, seq, event_class, plate, spot, spot_type, direction, received_at, received_ms, sig,
        accepted, duplicate, payload)
      VALUES (@event_id, @seq, @event_class, @plate, @spot, @spot_type, @direction, @received_at, @received_ms, @sig,
        @accepted, @duplicate, @payload)`);
    this.insSession = this.db.prepare(`
      INSERT INTO sessions (plate, car_type, status, entry_lane, exit_lane, spot, planned_minutes, arrived_at, parked_at,
        left_spot_at, exit_at, left_at, parked_seconds, charge_parking, charge_electric, charge_attempts, paid, payment_ok,
        recorded_at, data)
      VALUES (@plate, @car_type, @status, @entry_lane, @exit_lane, @spot, @planned_minutes, @arrived_at, @parked_at,
        @left_spot_at, @exit_at, @left_at, @parked_seconds, @charge_parking, @charge_electric, @charge_attempts, @paid,
        @payment_ok, @recorded_at, @data)`);
    this.insAction = this.db.prepare(
      `INSERT INTO actions (at, cmd, args, ok, error, ms, actor) VALUES (@at, @cmd, @args, @ok, @error, @ms, @actor)`);
  }


  // ---------------------------------------------------------------------------
  // writes
  // ---------------------------------------------------------------------------
  recordEvent(r: EventRecord): void {
    const { _received_at, _sig, _duplicate, _accepted, _seq_note, ...payload } = r;
    const seq = Number(payload.SequenceId);
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    this.insEvent.run({
      event_id: payload.EventId ?? null,
      seq: Number.isFinite(seq) ? seq : null,
      event_class: payload.EventClass ?? "?",
      plate: text(payload.CarPlateNumber),
      spot: text(payload.SpotName),
      spot_type: text(payload.SpotType),
      direction: text(payload.Direction),
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
    this.insAction.run({ ...a, args: JSON.stringify(a.args), ok: a.ok ? 1 : 0, actor: a.actor ?? null });
  }

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------
  /** Accepted events received since sinceMs, oldest first - for startup replay. */
  eventsSince(sinceMs: number): EventRecord[] {
    const rows = this.db.prepare(
      `SELECT payload, received_at, sig FROM events WHERE accepted = 1 AND received_ms >= ? ORDER BY id`,
    ).all(sinceMs) as { payload: string; received_at: string; sig: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.payload), _received_at: r.received_at, _sig: r.sig, _accepted: true }));
  }

  /** Commands sent since sinceMs, oldest first - replayed with the events after a restart. */
  actionsSince(sinceMs: number): ActionRecord[] {
    const rows = this.db.prepare("SELECT at, cmd, args, ok, error, ms, actor FROM actions WHERE at >= ? ORDER BY id")
      .all(new Date(sinceMs).toISOString()) as (Omit<ActionRecord, "ok" | "args"> & { ok: number; args: string })[];
    return rows.map((r) => ({ ...r, ok: !!r.ok, args: JSON.parse(r.args) }));
  }

  /** Finished sessions, newest first, filtered by (partial) plate, status and time. */
  searchSessions(opts: { plate?: string; status?: string; since?: string; until?: string; limit?: number; beforeId?: number }) {
    const where: string[] = [], params: Record<string, unknown> = { limit: Math.min(opts.limit ?? 100, 1000) };
    if (opts.plate) { where.push("plate LIKE @plate"); params.plate = `%${opts.plate}%`; }
    if (opts.status) { where.push("status = @status"); params.status = opts.status; }
    if (opts.since) { where.push("recorded_at >= @since"); params.since = opts.since; }
    if (opts.until) { where.push("recorded_at <= @until"); params.until = opts.until; }
    if (opts.beforeId) { where.push("id < @beforeId"); params.beforeId = opts.beforeId; }
    const rows = this.db.prepare(
      `SELECT id, recorded_at, data FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY id DESC LIMIT @limit`,
    ).all(params) as { id: number; recorded_at: string; data: string }[];
    return rows.map((r) => ({ id: r.id, recorded_at: r.recorded_at, ...JSON.parse(r.data) }));
  }

  /** Received webhooks, newest first, filtered by (partial) plate, class and time. */
  searchEvents(opts: { plate?: string; eventClass?: string; since?: string; until?: string; limit?: number; beforeId?: number }): EventView[] {
    const where: string[] = [], params: Record<string, unknown> = { limit: Math.min(opts.limit ?? 100, 1000) };
    if (opts.plate) { where.push("plate LIKE @plate"); params.plate = `%${opts.plate}%`; }
    if (opts.eventClass) { where.push("event_class = @cls"); params.cls = opts.eventClass; }
    if (opts.since) { where.push("received_ms >= @since"); params.since = Date.parse(opts.since); }
    if (opts.until) { where.push("received_ms <= @until"); params.until = Date.parse(opts.until); }
    if (opts.beforeId) { where.push("id < @beforeId"); params.beforeId = opts.beforeId; }
    const rows = this.db.prepare(
      `SELECT id, received_at, event_class, plate, spot, direction, sig, accepted, payload FROM events
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @limit`,
    ).all(params) as (Omit<EventView, "accepted" | "payload"> & { accepted: number; payload: string })[];
    return rows.map((r) => ({ ...r, accepted: !!r.accepted, payload: JSON.parse(r.payload) }));
  }

  /** Commands sent to the simulator, newest first; manualOnly = only those a user issued. */
  searchActions(opts: { manualOnly?: boolean; limit?: number }): ActionView[] {
    const rows = this.db.prepare(
      `SELECT id, at, cmd, args, ok, error, ms, actor FROM actions ${opts.manualOnly ? "WHERE actor IS NOT NULL" : ""}
       ORDER BY id DESC LIMIT ?`,
    ).all(Math.min(opts.limit ?? 100, 1000)) as (Omit<ActionView, "ok" | "args"> & { ok: number; args: string })[];
    return rows.map((r) => ({ ...r, ok: !!r.ok, args: JSON.parse(r.args) }));
  }

  stats(sinceMs: number, untilMs: number, bucketS: number): StatsResponse {
    return computeStats(this.db, sinceMs, untilMs, bucketS);
  }

  countUsers(): number { return countUsers(this.db); }
  listUsers(): UserView[] { return listUsers(this.db); }
  findUser(username: string): UserRow | undefined { return findUser(this.db, username); }
  getUser(id: number): UserView | undefined { return getUser(this.db, id); }
  createUser(username: string, passwordHash: string, role: Role): UserView { return createUser(this.db, username, passwordHash, role); }
  updateUser(id: number, changes: { role?: Role; disabled?: boolean; passwordHash?: string }): UserView | undefined {
    return updateUser(this.db, id, changes);
  }
  countOtherActiveAdmins(excludeId: number): number { return countOtherActiveAdmins(this.db, excludeId); }
  touchLogin(id: number): void { touchLogin(this.db, id); }
  createAuthSession(tokenHash: string, userId: number, expiresMs: number): void { createAuthSession(this.db, tokenHash, userId, expiresMs); }
  userForSession(tokenHash: string, nowMs: number): UserView | undefined { return userForSession(this.db, tokenHash, nowMs); }
  deleteAuthSession(tokenHash: string): void { deleteAuthSession(this.db, tokenHash); }
  deleteAuthSessionsForUser(userId: number): void { deleteAuthSessionsForUser(this.db, userId); }
  purgeExpiredAuthSessions(nowMs: number): void { purgeExpiredAuthSessions(this.db, nowMs); }
  close(): void {
    this.db.close();
  }
}
