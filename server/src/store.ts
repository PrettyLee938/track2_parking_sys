/**
 * Persistence (SQLite via better-sqlite3).
 *
 *   events         every webhook received, with intake metadata (signature, duplicate...)
 *   sessions       one row per finished car visit: plate, lanes, spot, times, charge, payment
 *   actions        every command sent to the simulator - by the controller or a named user
 *   users          dashboard accounts (role admin | operator)
 *   auth_sessions  login sessions (only a hash of each token is stored)
 *   components        usage and breakdown history per gate/spot/fan/light (Level 2)
 *   component_events  breakdowns, repairs sent, fixes (Level 2)
 *
 * Writes are synchronous and take microseconds, so they never hold up event handling.
 * Schema changes are applied in migrate() so existing databases keep working.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ActionView, AuditEntryView, ComponentEventView, ComponentKind, EventView, IncidentView, IncidentStatus, LoginAttemptView,
  MaintenanceJobView, MaintenanceStatus, PenaltyView, Role, SessionView, SimEventBase, StatsResponse, UserView,
} from "@gpa/shared";
import { createHash } from "node:crypto";

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

export interface UserRow extends UserView {
  password_hash: string;
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
  visit_id         TEXT,
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

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL
);

-- Level 2: component usage (survives restarts) and history (components.ts)
CREATE TABLE IF NOT EXISTS components (
  kind               TEXT NOT NULL,
  name               TEXT NOT NULL,
  zone               TEXT,
  uses               REAL NOT NULL,
  uses_total         REAL NOT NULL,
  breakdowns         INTEGER NOT NULL,
  uses_at_breakdown  TEXT NOT NULL,
  last_broken_at     TEXT,
  last_fixed_at      TEXT,
  last_event_seq     INTEGER,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

CREATE TABLE IF NOT EXISTS component_events (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  name    TEXT NOT NULL,
  zone    TEXT,
  event   TEXT NOT NULL,
  amount  REAL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS component_events_at ON component_events (at);

-- Durable webhook identity. Raw deliveries remain in events, including duplicates.
CREATE TABLE IF NOT EXISTS event_identities (
  event_id       TEXT PRIMARY KEY,
  payload_hash   TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  first_event_row INTEGER NOT NULL,
  accepted       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  username    TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ok          INTEGER NOT NULL,
  ip          TEXT,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS login_attempts_user ON login_attempts (username COLLATE NOCASE, id DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT,
  permission  TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  ok          INTEGER NOT NULL,
  reason      TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (id DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL,
  status        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  zone          TEXT,
  visit_id      TEXT,
  component     TEXT,
  reason        TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  resolution    TEXT,
  resolved_by   TEXT,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS incidents_status ON incidents (status, id DESC);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id               INTEGER PRIMARY KEY,
  component_kind   TEXT NOT NULL,
  component_name   TEXT NOT NULL,
  zone             TEXT,
  status           TEXT NOT NULL,
  reason           TEXT NOT NULL,
  actor            TEXT,
  evidence         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS maintenance_jobs_component ON maintenance_jobs (component_kind, component_name, id DESC);

CREATE TABLE IF NOT EXISTS command_intents (
  id              INTEGER PRIMARY KEY,
  command_id      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  cmd             TEXT NOT NULL,
  args            TEXT NOT NULL,
  status          TEXT NOT NULL,
  actor           TEXT,
  error           TEXT,
  finished_at     TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY,
  invoice_id      TEXT NOT NULL UNIQUE,
  visit_id        TEXT,
  plate           TEXT NOT NULL,
  parking_amount  REAL NOT NULL,
  electric_amount REAL NOT NULL,
  basis           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  settled_at      TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  event_id     TEXT,
  invoice_id   TEXT,
  visit_id     TEXT,
  plate        TEXT NOT NULL,
  amount       REAL NOT NULL,
  accepted     INTEGER NOT NULL,
  received_at  TEXT NOT NULL,
  UNIQUE(event_id),
  UNIQUE(invoice_id, amount)
);
`;

/** Persisted usage of one component (components.ts). */
export interface ComponentRow {
  kind: ComponentKind;
  name: string;
  zone: string;
  uses: number;
  uses_total: number;
  breakdowns: number;
  uses_at_breakdown: number[];
  last_broken_at: string | null;
  last_fixed_at: string | null;
  last_event_seq?: number | null;
}

const toUser = (r: Record<string, unknown>): UserView => ({
  id: r.id as number, username: r.username as string, role: r.role as Role, disabled: !!r.disabled,
  created_at: r.created_at as string, last_login_at: (r.last_login_at as string | null) ?? null,
});

/** "…charged wrongly with amount: (2.00)…" -> "…charged wrongly with amount: (…)…" so reasons group. */
const reasonKey = (reason: string) => reason.replace(/\([^)]*\)/g, "(…)").trim();
const payloadHash = (payload: Record<string, unknown>) => createHash("sha256")
  .update(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))))
  .digest("hex");
const toIncident = (r: Record<string, unknown>): IncidentView => ({
  id: r.id as number, at: r.at as string, status: r.status as IncidentStatus, kind: r.kind as string,
  zone: r.zone as string | null, visit_id: r.visit_id as string | null, component: r.component as string | null,
  reason: r.reason as string, confidence: r.confidence as "high" | "medium" | "low",
  evidence: JSON.parse(String(r.evidence ?? "{}")), resolution: r.resolution as string | null,
  resolved_by: r.resolved_by as string | null, resolved_at: r.resolved_at as string | null,
});

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
    this.migrate();
    this.insEvent = this.db.prepare(`
      INSERT INTO events (event_id, seq, event_class, plate, spot, spot_type, direction, received_at, received_ms, sig,
        accepted, duplicate, payload)
      VALUES (@event_id, @seq, @event_class, @plate, @spot, @spot_type, @direction, @received_at, @received_ms, @sig,
        @accepted, @duplicate, @payload)`);
    this.insSession = this.db.prepare(`
      INSERT INTO sessions (visit_id, plate, car_type, status, entry_lane, exit_lane, spot, planned_minutes, arrived_at, parked_at,
        left_spot_at, exit_at, left_at, parked_seconds, charge_parking, charge_electric, charge_attempts, paid, payment_ok,
        recorded_at, data)
      VALUES (@visit_id, @plate, @car_type, @status, @entry_lane, @exit_lane, @spot, @planned_minutes, @arrived_at, @parked_at,
        @left_spot_at, @exit_at, @left_at, @parked_seconds, @charge_parking, @charge_electric, @charge_attempts, @paid,
        @payment_ok, @recorded_at, @data)`);
    this.insAction = this.db.prepare(
      `INSERT INTO actions (at, cmd, args, ok, error, ms, actor) VALUES (@at, @cmd, @args, @ok, @error, @ms, @actor)`);
  }

  /** Additive schema changes for databases created by earlier versions. */
  private migrate() {
    const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const events = columns("events");
    if (!events.has("spot_type")) {
      this.db.exec(`ALTER TABLE events ADD COLUMN spot_type TEXT; ALTER TABLE events ADD COLUMN direction TEXT;
        UPDATE events SET spot_type = json_extract(payload, '$.SpotType'), direction = json_extract(payload, '$.Direction');`);
    }
    if (!columns("sessions").has("visit_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN visit_id TEXT");
    if (!columns("components").has("last_event_seq")) this.db.exec("ALTER TABLE components ADD COLUMN last_event_seq INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_flow ON events (spot_type, direction, received_ms)");
    if (!columns("actions").has("actor")) this.db.exec("ALTER TABLE actions ADD COLUMN actor TEXT");
  }

  // ---------------------------------------------------------------------------
  // components (Level 2)
  // ---------------------------------------------------------------------------
  loadComponent(kind: ComponentKind, name: string): ComponentRow | null {
    const r = this.db.prepare("SELECT * FROM components WHERE kind = ? AND name = ?").get(kind, name) as
      (Omit<ComponentRow, "uses_at_breakdown"> & { uses_at_breakdown: string }) | undefined;
    return r ? { ...r, uses_at_breakdown: JSON.parse(r.uses_at_breakdown) } : null;
  }

  saveComponent(c: ComponentRow): void {
    this.db.prepare(`
      INSERT INTO components (kind, name, zone, uses, uses_total, breakdowns, uses_at_breakdown, last_broken_at, last_fixed_at, last_event_seq, updated_at)
      VALUES (@kind, @name, @zone, @uses, @uses_total, @breakdowns, @uses_at_breakdown, @last_broken_at, @last_fixed_at, @last_event_seq, @updated_at)
      ON CONFLICT (kind, name) DO UPDATE SET zone = @zone, uses = @uses, uses_total = @uses_total, breakdowns = @breakdowns,
        uses_at_breakdown = @uses_at_breakdown, last_broken_at = @last_broken_at, last_fixed_at = @last_fixed_at,
        last_event_seq = @last_event_seq, updated_at = @updated_at`,
    ).run({ ...c, uses_at_breakdown: JSON.stringify(c.uses_at_breakdown), updated_at: new Date().toISOString() });
  }

  recordComponentEvent(e: Omit<ComponentEventView, "id">): void {
    this.db.prepare("INSERT INTO component_events (at, kind, name, zone, event, amount, detail) VALUES (@at, @kind, @name, @zone, @event, @amount, @detail)")
      .run(e);
  }

  /** Breakdowns, repairs and fixes, newest first. */
  listComponentEvents(opts: { limit?: number; name?: string; since?: string } = {}): ComponentEventView[] {
    const where: string[] = [], params: Record<string, unknown> = { limit: Math.min(opts.limit ?? 200, 2000) };
    if (opts.name) { where.push("name = @name"); params.name = opts.name; }
    if (opts.since) { where.push("at >= @since"); params.since = opts.since; }
    return this.db.prepare(`SELECT * FROM component_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT @limit`)
      .all(params) as ComponentEventView[];
  }

  // ---------------------------------------------------------------------------
  // durable trust, audit, incidents, maintenance
  // ---------------------------------------------------------------------------
  /** Durable identity check used before the in-memory intake dedupe. */
  eventIdentity(eventId: string | undefined, payload: Record<string, unknown>): "new" | "duplicate" | "conflict" {
    if (!eventId) return "new";
    const row = this.db.prepare("SELECT payload_hash FROM event_identities WHERE event_id = ?").get(eventId) as { payload_hash: string } | undefined;
    if (!row) return "new";
    return row.payload_hash === payloadHash(payload) ? "duplicate" : "conflict";
  }

  recordLoginAttempt(input: { username: string; userId?: number | null; ok: boolean; ip?: string | null; reason?: string | null }): number {
    const info = this.db.prepare("INSERT INTO login_attempts (at, username, user_id, ok, ip, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), input.username, input.userId ?? null, input.ok ? 1 : 0, input.ip ?? null, input.reason ?? null);
    return Number(info.lastInsertRowid);
  }

  listLoginAttempts(username: string, limit = 3, beforeId?: number): LoginAttemptView[] {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const rows = (beforeId
      ? this.db.prepare(`SELECT id, at, username, ok, ip, reason FROM login_attempts
        WHERE username = ? COLLATE NOCASE AND id < ? ORDER BY id DESC LIMIT ?`).all(username, beforeId, safeLimit)
      : this.db.prepare(`SELECT id, at, username, ok, ip, reason FROM login_attempts
        WHERE username = ? COLLATE NOCASE ORDER BY id DESC LIMIT ?`).all(username, safeLimit)) as
      { id: number; at: string; username: string; ok: number; ip: string | null; reason: string | null }[];
    return rows.map((r) => ({ ...r, ok: !!r.ok }));
  }

  listLoginAttemptsForAdmin(limit = 100): LoginAttemptView[] {
    const rows = this.db.prepare("SELECT id, at, username, ok, ip, reason FROM login_attempts ORDER BY id DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 500)) as { id: number; at: string; username: string; ok: number; ip: string | null; reason: string | null }[];
    return rows.map((r) => ({ ...r, ok: !!r.ok }));
  }

  recordAudit(input: { actor?: string | null; permission?: string | null; action: string; target?: string | null; ok: boolean; reason?: string | null; detail?: unknown }): number {
    const info = this.db.prepare(`INSERT INTO audit_log (at, actor, permission, action, target, ok, reason, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), input.actor ?? null, input.permission ?? null,
      input.action, input.target ?? null, input.ok ? 1 : 0, input.reason ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail));
    return Number(info.lastInsertRowid);
  }

  listAudit(limit = 100): AuditEntryView[] {
    const rows = this.db.prepare("SELECT id, at, actor, action, target, ok, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 1000)) as { id: number; at: string; actor: string | null; action: string; target: string | null; ok: number; detail: string | null }[];
    return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target, ok: !!r.ok, detail: r.detail }));
  }

  createIncident(input: { status: IncidentStatus; kind: string; zone?: string | null; visit_id?: string | null; component?: string | null;
    reason: string; confidence: "high" | "medium" | "low"; evidence?: unknown }): IncidentView {
    const at = new Date().toISOString();
    const info = this.db.prepare(`INSERT INTO incidents (at, status, kind, zone, visit_id, component, reason, confidence, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(at, input.status, input.kind, input.zone ?? null, input.visit_id ?? null, input.component ?? null,
      input.reason, input.confidence, JSON.stringify(input.evidence ?? {}));
    return this.getIncident(Number(info.lastInsertRowid))!;
  }

  getIncident(id: number): IncidentView | undefined {
    const r = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toIncident(r) : undefined;
  }

  listIncidents(opts: { status?: IncidentStatus; limit?: number; since?: string; until?: string } = {}): IncidentView[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const where: string[] = [], params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.since) { where.push("at >= ?"); params.push(opts.since); }
    if (opts.until) { where.push("at < ?"); params.push(opts.until); }
    params.push(limit);
    const rows = this.db.prepare(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(toIncident);
  }

  resolveIncident(id: number, actor: string, resolution: string, status: IncidentStatus = "resolved"): IncidentView | undefined {
    this.db.prepare("UPDATE incidents SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
      .run(status, resolution, actor, new Date().toISOString(), id);
    return this.getIncident(id);
  }

  createMaintenanceJob(input: { kind: ComponentKind; name: string; zone?: string | null; status: MaintenanceStatus; reason: string; actor?: string | null; evidence?: unknown }): number {
    const active = this.db.prepare(`SELECT id FROM maintenance_jobs
      WHERE component_kind = ? AND component_name = ?
        AND status IN ('scheduled', 'waiting_for_clearance', 'requested', 'in_progress', 'outcome_unknown')
      ORDER BY id DESC LIMIT 1`).get(input.kind, input.name) as { id: number } | undefined;
    if (active) return active.id;
    const now = new Date().toISOString();
    const info = this.db.prepare(`INSERT INTO maintenance_jobs (component_kind, component_name, zone, status, reason, actor, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.kind, input.name, input.zone ?? null, input.status, input.reason, input.actor ?? null,
      JSON.stringify(input.evidence ?? {}), now, now);
    return Number(info.lastInsertRowid);
  }

  updateMaintenanceJob(kind: ComponentKind, name: string, status: MaintenanceStatus, evidence?: unknown): void {
    this.db.prepare(`UPDATE maintenance_jobs SET status = ?, evidence = COALESCE(?, evidence), updated_at = ?
      WHERE id = (SELECT id FROM maintenance_jobs WHERE component_kind = ? AND component_name = ? ORDER BY id DESC LIMIT 1)`)
      .run(status, evidence === undefined ? null : JSON.stringify(evidence), new Date().toISOString(), kind, name);
  }

  listMaintenanceJobs(limit = 100): MaintenanceJobView[] {
    const rows = this.db.prepare("SELECT * FROM maintenance_jobs ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 1000)) as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id as number, component_kind: r.component_kind as ComponentKind, component_name: r.component_name as string,
      zone: r.zone as string | null, status: r.status as MaintenanceStatus, reason: r.reason as string, actor: r.actor as string | null,
      created_at: r.created_at as string, updated_at: r.updated_at as string, evidence: JSON.parse(String(r.evidence ?? "{}")) }));
  }

  listPenalties(limit = 200, range: { sinceMs?: number; untilMs?: number } = {}): PenaltyView[] {
    const where = ["accepted = 1", "event_class = 'penalty'"], params: unknown[] = [];
    if (range.sinceMs !== undefined) { where.push("received_ms >= ?"); params.push(range.sinceMs); }
    if (range.untilMs !== undefined) { where.push("received_ms < ?"); params.push(range.untilMs); }
    params.push(Math.min(Math.max(limit, 1), 2000));
    const rows = this.db.prepare(`SELECT id, received_at, payload FROM events WHERE ${where.join(" AND ")}
      ORDER BY id DESC LIMIT ?`).all(...params) as { id: number; received_at: string; payload: string }[];
    return rows.map((r) => { const p = JSON.parse(r.payload) as Record<string, unknown>; return {
      id: r.id, at: r.received_at, reason: String(p.Reason ?? ""), type: p.Type ? String(p.Type) : null,
      component: p.ComponentName ? String(p.ComponentName) : null, fine: Number(p.FineAmount) || 0,
    }; });
  }

  createInvoice(input: { invoiceId: string; visitId?: string | null; plate: string; parkingAmount: number; electricAmount: number; basis: string }): void {
    this.db.prepare(`INSERT OR IGNORE INTO invoices (invoice_id, visit_id, plate, parking_amount, electric_amount, basis, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'intended', ?)`).run(input.invoiceId, input.visitId ?? null, input.plate,
      input.parkingAmount, input.electricAmount, input.basis, new Date().toISOString());
  }

  findInvoice(visitId: string | null | undefined, plate: string): { invoice_id: string; visit_id: string | null; parking_amount: number; electric_amount: number; basis: string; status: string } | undefined {
    const row = (visitId
      ? this.db.prepare("SELECT invoice_id, visit_id, parking_amount, electric_amount, basis, status FROM invoices WHERE visit_id = ? ORDER BY id DESC LIMIT 1").get(visitId)
      : this.db.prepare("SELECT invoice_id, visit_id, parking_amount, electric_amount, basis, status FROM invoices WHERE plate = ? ORDER BY id DESC LIMIT 1").get(plate)) as
      { invoice_id: string; visit_id: string | null; parking_amount: number; electric_amount: number; basis: string; status: string } | undefined;
    if (row || !visitId) return row;
    // Visit ids are derived from the simulator arrival EventId when possible. Older
    // records (and a crash before that migration) may not have one, so rehydrate the
    // latest plate invoice as a conservative restart fallback. The controller still
    // refuses to issue a second charge for any restored invoice.
    return this.db.prepare("SELECT invoice_id, visit_id, parking_amount, electric_amount, basis, status FROM invoices WHERE plate = ? AND status IN ('intended', 'issued', 'outcome_unknown') ORDER BY id DESC LIMIT 1").get(plate) as
      { invoice_id: string; visit_id: string | null; parking_amount: number; electric_amount: number; basis: string; status: string } | undefined;
  }

  updateInvoiceStatus(invoiceId: string, status: string): void {
    this.db.prepare("UPDATE invoices SET status = ? WHERE invoice_id = ?").run(status, invoiceId);
  }

  recordPayment(input: { eventId?: string | null; invoiceId?: string | null; visitId?: string | null; plate: string; amount: number; accepted: boolean }): void {
    if (input.eventId) {
      const existing = this.db.prepare("SELECT id FROM payments WHERE event_id = ?").get(input.eventId);
      if (existing) return;
    }
    try {
      this.db.prepare(`INSERT INTO payments (event_id, invoice_id, visit_id, plate, amount, accepted, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.eventId ?? null, input.invoiceId ?? null, input.visitId ?? null, input.plate,
        input.amount, input.accepted ? 1 : 0, new Date().toISOString());
    } catch (err) {
      // The UNIQUE(invoice_id, amount) constraint is deliberate: a repeated matching
      // payment must not become revenue or another physical passage.
      if (!(err instanceof Error) || !/UNIQUE/i.test(err.message)) throw err;
    }
    if (input.accepted && input.invoiceId) this.db.prepare("UPDATE invoices SET status = 'settled', settled_at = COALESCE(settled_at, ?) WHERE invoice_id = ?")
      .run(new Date().toISOString(), input.invoiceId);
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
    // A rejected delivery is still in the raw event log, but must not reserve its
    // identity. Otherwise an unsigned/invalid request could block the later valid
    // signed simulator delivery that uses the same EventId.
    if (payload.EventId && _accepted !== false) {
      const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
      this.db.prepare(`INSERT OR IGNORE INTO event_identities (event_id, payload_hash, first_seen_at, first_event_row, accepted)
        VALUES (?, ?, ?, ?, 1)`).run(payload.EventId, payloadHash(payload), _received_at, row.id);
    }
  }

  recordSession(s: SessionView): void {
    this.insSession.run({
      ...s, visit_id: s.visit_id ?? null,
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

  // ---------------------------------------------------------------------------
  // statistics
  // ---------------------------------------------------------------------------
  /** Aggregates over [sinceMs, untilMs], bucketed by bucketS for the time series. */
  stats(sinceMs: number, untilMs: number, bucketS: number): StatsResponse {
    const since = new Date(sinceMs).toISOString(), until = new Date(untilMs).toISOString();
    const nBuckets = Math.max(1, Math.ceil((untilMs - sinceMs) / (bucketS * 1000)));
    const buckets = Array.from({ length: nBuckets }, (_, i) => ({
      t: new Date(sinceMs + i * bucketS * 1000).toISOString(), arrivals: 0, departures: 0, revenue: 0, turned_away: 0, penalties: 0,
    }));
    const bucketOf = (ms: number) => buckets[Math.min(nBuckets - 1, Math.max(0, Math.floor((ms - sinceMs) / (bucketS * 1000))))];

    // arrivals: a car reaching an entry sensor
    const arrivals = this.db.prepare(
      `SELECT received_ms FROM events WHERE accepted = 1 AND spot_type = 'EntrySpot' AND direction = 'CarIn' AND received_ms BETWEEN ? AND ?`,
    ).all(sinceMs, untilMs) as { received_ms: number }[];
    for (const a of arrivals) bucketOf(a.received_ms).arrivals++;

    // finished visits
    const sessions = this.db.prepare(
      `SELECT recorded_at, status, spot, planned_minutes, paid, payment_ok, exit_lane FROM sessions WHERE recorded_at BETWEEN ? AND ?`,
    ).all(since, until) as { recorded_at: string; status: string; spot: string | null; planned_minutes: number | null;
      paid: number | null; payment_ok: number | null; exit_lane: string | null }[];
    let departures = 0, turnedAway = 0, neglected = 0, lost = 0, revenue = 0, paidCount = 0, mismatches = 0, escaped = 0;
    let plannedSum = 0, plannedN = 0;
    const stay = new Map<number, number>(), usage = new Map<string, number>();
    for (const s of sessions) {
      const b = bucketOf(Date.parse(s.recorded_at));
      if (s.status === "gone") {
        departures++; b.departures++;
        if (s.payment_ok === 1) { revenue += s.paid ?? 0; b.revenue += s.paid ?? 0; paidCount++; }
        else if (s.exit_lane) escaped++;
        if (s.planned_minutes) { stay.set(s.planned_minutes, (stay.get(s.planned_minutes) ?? 0) + 1); plannedSum += s.planned_minutes; plannedN++; }
      }
      if (s.payment_ok === 0) mismatches++;
      if (s.status === "turned_away") { turnedAway++; b.turned_away++; }
      if (s.status === "neglected") neglected++;
      if (s.status === "lost") lost++;
      if (s.spot && (s.status === "gone" || s.status === "lost")) usage.set(s.spot, (usage.get(s.spot) ?? 0) + 1);
    }

    // penalties and gate cycles, from the event payloads
    const other = this.db.prepare(
      `SELECT received_ms, event_class, payload FROM events WHERE accepted = 1 AND event_class IN ('penalty', 'gate_action') AND received_ms BETWEEN ? AND ?`,
    ).all(sinceMs, untilMs) as { received_ms: number; event_class: string; payload: string }[];
    const penalties = new Map<string, { count: number; fines: number }>(), gates = new Map<string, number>();
    let fines = 0, penaltyCount = 0;
    for (const r of other) {
      const p = JSON.parse(r.payload);
      if (r.event_class === "penalty") {
        const key = reasonKey(String(p.Reason ?? "unknown"));
        const fine = Number(p.FineAmount) || 0;
        const agg = penalties.get(key) ?? { count: 0, fines: 0 };
        agg.count++; agg.fines += fine; penalties.set(key, agg);
        fines += fine; penaltyCount++; bucketOf(r.received_ms).penalties++;
      } else if (p.Action === "Open") {
        gates.set(p.Name, (gates.get(p.Name) ?? 0) + 1);
      }
    }

    // command health
    const acts = this.db.prepare(`SELECT cmd, ok, ms FROM actions WHERE at BETWEEN ? AND ?`).all(since, until) as { cmd: string; ok: number; ms: number }[];
    const byCmd = new Map<string, { ms: number[]; failed: number }>();
    for (const a of acts) {
      const agg = byCmd.get(a.cmd) ?? { ms: [], failed: 0 };
      agg.ms.push(a.ms ?? 0); if (!a.ok) agg.failed++; byCmd.set(a.cmd, agg);
    }
    const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

    return {
      since, until, bucket_s: bucketS,
      totals: {
        arrivals: arrivals.length, departures, turned_away: turnedAway, neglected, lost,
        revenue: round(revenue), avg_ticket: paidCount ? round(revenue / paidCount) : 0,
        avg_planned_min: plannedN ? round(plannedSum / plannedN, 1) : 0,
        penalties: penaltyCount, fines: round(fines), payment_mismatches: mismatches, escaped,
      },
      buckets: buckets.map((b) => ({ ...b, revenue: round(b.revenue) })),
      stay_histogram: [...stay.entries()].sort((a, b) => a[0] - b[0]).map(([minutes, count]) => ({ minutes, count })),
      spot_usage: [...usage.entries()].map(([spot, visits]) => ({ spot, visits }))
        .sort((a, b) => b.visits - a.visits || a.spot.localeCompare(b.spot, undefined, { numeric: true })),
      penalties_by_reason: [...penalties.entries()].map(([reason, v]) => ({ reason, ...v, fines: round(v.fines) }))
        .sort((a, b) => b.count - a.count),
      gate_cycles: [...gates.entries()].map(([gate, opens]) => ({ gate, opens })).sort((a, b) => b.opens - a.opens),
      commands: [...byCmd.entries()].map(([cmd, v]) => {
        const s = [...v.ms].sort((a, b) => a - b);
        return { cmd, count: s.length, failed: v.failed, avg_ms: round(s.reduce((x, y) => x + y, 0) / s.length, 1),
          p95_ms: round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], 1) };
      }).sort((a, b) => b.count - a.count),
    };
  }

  // ---------------------------------------------------------------------------
  // users & login sessions
  // ---------------------------------------------------------------------------
  countUsers(): number {
    return (this.db.prepare("SELECT count(*) n FROM users").get() as { n: number }).n;
  }

  listUsers(): UserView[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as Record<string, unknown>[]).map(toUser);
  }

  findUser(username: string): UserRow | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Record<string, unknown> | undefined;
    return r ? { ...toUser(r), password_hash: r.password_hash as string } : undefined;
  }

  getUser(id: number): UserView | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toUser(r) : undefined;
  }

  createUser(username: string, passwordHash: string, role: Role): UserView {
    const info = this.db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
      .run(username, passwordHash, role, new Date().toISOString());
    return this.getUser(Number(info.lastInsertRowid))!;
  }

  updateUser(id: number, changes: { role?: Role; disabled?: boolean; passwordHash?: string }): UserView | undefined {
    if (changes.role !== undefined) this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(changes.role, id);
    if (changes.disabled !== undefined) this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(changes.disabled ? 1 : 0, id);
    if (changes.passwordHash !== undefined) this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(changes.passwordHash, id);
    return this.getUser(id);
  }

  /** Active admins other than excludeId - to refuse removing the last one. */
  countOtherActiveAdmins(excludeId: number): number {
    return (this.db.prepare("SELECT count(*) n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(excludeId) as { n: number }).n;
  }

  touchLogin(id: number): void {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  createAuthSession(tokenHash: string, userId: number, expiresMs: number): void {
    this.db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_ms) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, new Date().toISOString(), expiresMs);
  }

  /** The (enabled) user behind a login session, if it has not expired. */
  userForSession(tokenHash: string, nowMs: number): UserView | undefined {
    const r = this.db.prepare(
      `SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_ms > ? AND u.disabled = 0`,
    ).get(tokenHash, nowMs) as Record<string, unknown> | undefined;
    return r ? toUser(r) : undefined;
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteAuthSessionsForUser(userId: number): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  }

  purgeExpiredAuthSessions(nowMs: number): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_ms <= ?").run(nowMs);
  }

  close(): void {
    this.db.close();
  }
}
