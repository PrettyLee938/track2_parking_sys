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
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ActionView, CommandIntentStatus, CommandIntentView, DailyReportFinancial, DailyReportOperational, EventView,
  FinancialAdjustmentKind, FinancialAdjustmentView,
  IncidentSeverity, IncidentStatus, IncidentView, InvoiceStatus, InvoiceView, MaintenanceComponentType, MaintenanceJobView,
  MaintenanceStatus, PenaltyDetailView, PenaltyEvidenceCommand, PenaltyEvidenceEvent, PenaltyLinkedIncident,
  PenaltyRelatedVisit, PenaltyResolutionStatus, PenaltyView, Role, SessionView, SimEventBase, StatsResponse, UserView,
  CoZoneSafetyState } from "@gpa/shared";
import type { PersistedSimulatorCalendarRecord } from "./simulatorCalendar";
import { payloadHash } from "./webhook";

/** A received webhook as the controller sees it: the payload plus intake metadata. */
export type EventRecord = SimEventBase & {
  _received_at: string;
  _sig?: string;
  _duplicate?: boolean;
  _conflict?: boolean;
  _seq_note?: string;
  _accepted?: boolean;
  _payload_hash?: string;
  _raw_body?: string;
  _profile?: WebhookProfile;
  _rejection_reason?: string | null;
};

export type WebhookProfile = "level1" | "level2";

export interface PersistedWebhookOutcome {
  accept: boolean;
  duplicate: boolean;
  conflict: boolean;
  seqNote: string;
  lastSeq: number | null;
}

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
  conflict     INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT,
  raw_body     TEXT,
  profile      TEXT NOT NULL DEFAULT 'level1',
  rejection_reason TEXT,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_received ON events (received_ms);
CREATE INDEX IF NOT EXISTS events_plate    ON events (plate, received_ms);
CREATE INDEX IF NOT EXISTS events_class    ON events (event_class, received_ms);

CREATE TABLE IF NOT EXISTS webhook_sequence (
  profile  TEXT PRIMARY KEY CHECK (profile IN ('level1', 'level2')),
  last_seq INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY,
  visit_id         TEXT,
  run_id           TEXT,
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
CREATE TABLE IF NOT EXISTS visits (
  visit_id TEXT PRIMARY KEY,
  entry_event_id TEXT UNIQUE,
  plate TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS visits_plate ON visits (plate, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS visits_active_plate ON visits (plate) WHERE ended_at IS NULL;

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
  role           TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'maintenance')),
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  login_attempt_id INTEGER
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  attempted_at TEXT NOT NULL,
  attempted_ms INTEGER NOT NULL,
  attempted_username TEXT NOT NULL,
  user_id INTEGER,
  success INTEGER NOT NULL,
  category TEXT NOT NULL,
  source_ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS login_attempts_user ON login_attempts (user_id, id DESC);
CREATE INDEX IF NOT EXISTS login_attempts_time ON login_attempts (attempted_ms DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id INTEGER,
  actor_username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  reason TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log (at DESC);
CREATE TABLE IF NOT EXISTS simulator_calendar_records (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('anchor', 'invalidate')),
  run_id TEXT,
  simulator_time_iso TEXT,
  real_anchor_ms REAL,
  calendar_seconds_per_real_second REAL,
  day_start_minute INTEGER,
  night_start_minute INTEGER,
  process_instance_token TEXT,
  reason TEXT NOT NULL,
  actor_id INTEGER,
  actor_username TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK (
    (action = 'anchor' AND run_id IS NOT NULL AND simulator_time_iso IS NOT NULL AND real_anchor_ms IS NOT NULL
      AND calendar_seconds_per_real_second IS NOT NULL AND day_start_minute IS NOT NULL AND night_start_minute IS NOT NULL
      AND process_instance_token IS NOT NULL)
    OR
    (action = 'invalidate' AND simulator_time_iso IS NULL AND real_anchor_ms IS NULL
      AND calendar_seconds_per_real_second IS NULL AND day_start_minute IS NULL AND night_start_minute IS NULL
      AND process_instance_token IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS simulator_calendar_records_recent ON simulator_calendar_records (id DESC);
CREATE TRIGGER IF NOT EXISTS simulator_calendar_records_no_update
BEFORE UPDATE ON simulator_calendar_records BEGIN SELECT RAISE(ABORT, 'simulator calendar records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS simulator_calendar_records_no_delete
BEFORE DELETE ON simulator_calendar_records BEGIN SELECT RAISE(ABORT, 'simulator calendar records are append-only'); END;
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id TEXT PRIMARY KEY,
  component_type TEXT NOT NULL CHECK (component_type IN ('gate', 'spot', 'fan', 'light')),
  component TEXT NOT NULL,
  zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'completed', 'failed')),
  requested_by TEXT NOT NULL,
  assigned_to TEXT,
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS maintenance_jobs_recent ON maintenance_jobs (requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_jobs_active_component ON maintenance_jobs (component_type, component)
  WHERE status IN ('requested', 'in_progress');
CREATE TABLE IF NOT EXISTS command_intents (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cmd TEXT NOT NULL,
  args TEXT NOT NULL,
  actor TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'confirmed', 'rejected', 'outcome_unknown')),
  error TEXT
);
CREATE INDEX IF NOT EXISTS command_intents_recent ON command_intents (at DESC);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  correlation_key TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  summary TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  plate TEXT,
  component TEXT,
  component_type TEXT,
  zone TEXT,
  lane TEXT,
  reason TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents (status, severity, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_active_correlation ON incidents (type, correlation_key)
  WHERE correlation_key IS NOT NULL AND status != 'resolved';
CREATE TABLE IF NOT EXISTS co_zone_state (
  zone TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL,
  plate TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parking_minor INTEGER NOT NULL CHECK (parking_minor >= 0),
  electricity_minor INTEGER NOT NULL CHECK (electricity_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  billing_basis TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'outcome_unknown', 'issued', 'settled', 'rejected', 'superseded', 'waived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_minor INTEGER,
  payment_event_id TEXT
);
CREATE INDEX IF NOT EXISTS invoices_plate_recent ON invoices (plate, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_active_visit ON invoices (visit_id)
  WHERE status IN ('pending', 'outcome_unknown', 'issued');
CREATE TABLE IF NOT EXISTS financial_adjustments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  visit_id TEXT NOT NULL,
  invoice_id TEXT,
  plate TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('adjustment', 'waiver', 'emergency_release')),
  amount_minor INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS financial_adjustments_visit ON financial_adjustments (visit_id, at DESC);
`;

export interface LoginAttemptRecord {
  username: string;
  userId?: number | null;
  success: boolean;
  category: string;
  sourceIp?: string | null;
  userAgent?: string | null;
  at?: string;
}

export interface AuditRecord {
  actorId?: number | null;
  actorUsername?: string | null;
  action: string;
  target?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
  at?: string;
}

export type SimulatorCalendarWriteRecord = PersistedSimulatorCalendarRecord extends infer T
  ? T extends PersistedSimulatorCalendarRecord ? Omit<T, "recordedAt"> & { recordedAt?: string } : never
  : never;

export interface SimulatorCalendarAuditContext {
  actorId: number;
  actorUsername: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface ManualSpotOccupancyState {
  spot: string;
  occupied: boolean;
  version: number;
  actor: string | null;
  at: string;
  reason: string | null;
  observation: string | null;
}

export type ManualSpotOccupancyAction = "spot.manual_occupancy.reported" | "spot.manual_occupancy.cleared";

export interface CreateMaintenanceJob {
  componentType: MaintenanceComponentType;
  component: string;
  zone: string;
  requestedBy: string;
  assignedTo?: string | null;
  reason: string;
  status?: MaintenanceStatus;
}

export interface CreateIncident {
  type: string;
  correlationKey?: string | null;
  severity: IncidentSeverity;
  summary: string;
  plate?: string | null;
  component?: string | null;
  componentType?: string | null;
  zone?: string | null;
  lane?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

const toUser = (r: Record<string, unknown>): UserView => ({
  id: r.id as number, username: r.username as string, role: r.role as Role, disabled: !!r.disabled,
  created_at: r.created_at as string, last_login_at: (r.last_login_at as string | null) ?? null,
});

/** "…charged wrongly with amount: (2.00)…" -> "…charged wrongly with amount: (…)…" so reasons group. */
const reasonKey = (reason: string) => reason.replace(/\([^)]*\)/g, "(…)").trim();

/** Parse a simulator currency value without treating missing or malformed fines as zero. */
function simulatorAmountMinor(value: unknown): number | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function payloadText(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function commandArgs(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 10).map((arg) => String(arg).slice(0, 100)) : [];
  } catch {
    return [];
  }
}

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
        accepted, duplicate, conflict, payload_hash, raw_body, profile, rejection_reason, payload)
      VALUES (@event_id, @seq, @event_class, @plate, @spot, @spot_type, @direction, @received_at, @received_ms, @sig,
        @accepted, @duplicate, @conflict, @payload_hash, @raw_body, @profile, @rejection_reason, @payload)`);
    this.insSession = this.db.prepare(`
      INSERT INTO sessions (visit_id, run_id, plate, car_type, status, entry_lane, exit_lane, spot, planned_minutes, arrived_at, parked_at,
        left_spot_at, exit_at, left_at, parked_seconds, charge_parking, charge_electric, charge_attempts, paid, payment_ok,
        recorded_at, data)
      VALUES (@visit_id, @run_id, @plate, @car_type, @status, @entry_lane, @exit_lane, @spot, @planned_minutes, @arrived_at, @parked_at,
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
    if (!events.has("conflict")) this.db.exec("ALTER TABLE events ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0");
    if (!events.has("payload_hash")) this.db.exec("ALTER TABLE events ADD COLUMN payload_hash TEXT");
    if (!events.has("raw_body")) this.db.exec("ALTER TABLE events ADD COLUMN raw_body TEXT");
    if (!events.has("profile")) this.db.exec("ALTER TABLE events ADD COLUMN profile TEXT NOT NULL DEFAULT 'level1'");
    if (!events.has("rejection_reason")) this.db.exec("ALTER TABLE events ADD COLUMN rejection_reason TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_flow ON events (spot_type, direction, received_ms)");
    if (!columns("actions").has("actor")) this.db.exec("ALTER TABLE actions ADD COLUMN actor TEXT");
    const sessions = columns("sessions");
    if (!sessions.has("visit_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN visit_id TEXT");
    if (!sessions.has("run_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN run_id TEXT");
    if (!columns("auth_sessions").has("login_attempt_id")) this.db.exec("ALTER TABLE auth_sessions ADD COLUMN login_attempt_id INTEGER");
    if (!columns("maintenance_jobs").has("assigned_to")) this.db.exec("ALTER TABLE maintenance_jobs ADD COLUMN assigned_to TEXT");

    // SQLite cannot alter a CHECK constraint. Rebuild only the users table while
    // preserving IDs; auth_sessions keeps its FK to the renamed `users` table.
    const usersSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string } | undefined)?.sql ?? "";
    if (!usersSql.includes("maintenance")) {
      this.db.pragma("foreign_keys = OFF");
      try {
        this.db.transaction(() => {
          this.db.exec(`CREATE TABLE users_next (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'maintenance')),
            disabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_login_at TEXT
          );
          INSERT INTO users_next (id, username, password_hash, role, disabled, created_at, last_login_at)
            SELECT id, username, password_hash, role, disabled, created_at, last_login_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_next RENAME TO users;`);
        })();
      } finally {
        this.db.pragma("foreign_keys = ON");
      }
    }

    if (!columns("auth_sessions").has("login_attempt_id")) this.db.exec("ALTER TABLE auth_sessions ADD COLUMN login_attempt_id INTEGER");

    // An HTTP success acknowledges a command request; only later simulator evidence
    // confirms the physical action. Rebuild this ledger for older databases.
    const intentsSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'command_intents'").get() as { sql: string } | undefined)?.sql ?? "";
    if (!intentsSql.includes("acknowledged")) {
      this.db.exec(`DROP INDEX IF EXISTS command_intents_recent;
        ALTER TABLE command_intents RENAME TO command_intents_old;
        CREATE TABLE command_intents (
          id TEXT PRIMARY KEY, at TEXT NOT NULL, updated_at TEXT NOT NULL, cmd TEXT NOT NULL, args TEXT NOT NULL,
          actor TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'confirmed', 'rejected', 'outcome_unknown')),
          error TEXT
        );
        INSERT INTO command_intents (id, at, updated_at, cmd, args, actor, status, error)
          SELECT id, at, updated_at, cmd, args, actor,
            CASE status WHEN 'confirmed' THEN 'acknowledged' ELSE status END, error FROM command_intents_old;
        DROP TABLE command_intents_old;
        CREATE INDEX command_intents_recent ON command_intents (at DESC);`);
    }

    // Hash prior accepted records so their event IDs remain idempotent after upgrade.
    const unhashed = this.db.prepare("SELECT id, payload FROM events WHERE payload_hash IS NULL").all() as { id: number; payload: string }[];
    const updateHash = this.db.prepare("UPDATE events SET payload_hash = ? WHERE id = ?");
    const hashOldRecords = this.db.transaction(() => {
      for (const row of unhashed) {
        try { updateHash.run(payloadHash(JSON.parse(row.payload)), row.id); } catch { /* retain the row; it remains visible in the log */ }
      }
    });
    hashOldRecords();

    // Seed Level 1 progress for databases predating the durable profile cursor.
    const priorSeq = this.db.prepare("SELECT seq FROM events WHERE accepted = 1 AND seq IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { seq: number } | undefined;
    if (priorSeq) this.db.prepare("INSERT OR IGNORE INTO webhook_sequence (profile, last_seq) VALUES ('level1', ?)").run(priorSeq.seq);
  }

  // ---------------------------------------------------------------------------
  // writes
  // ---------------------------------------------------------------------------
  recordEvent(r: EventRecord): void {
    this.insertEvent(r);
  }

  /** Persist the delivery, signature decision, duplicate decision, and sequence cursor atomically. */
  persistWebhook(event: SimEventBase, options: {
    receivedAt: string;
    rawBody: string;
    sig: string;
    trusted: boolean;
    profile: WebhookProfile;
    rejectionReason?: string | null;
  }): PersistedWebhookOutcome {
    const hash = payloadHash(event);
    const eventId = typeof event.EventId === "string" && event.EventId.length ? event.EventId : null;
    const seq = this.sequenceOf(event.SequenceId);

    return this.db.transaction(() => {
      let lastSeq = this.readWebhookSequence(options.profile);
      let duplicate = false, conflict = false;

      // Rejected deliveries are recorded but can never reserve an ID or move the cursor.
      if (options.trusted && eventId !== null) {
        const prior = this.db.prepare(
          "SELECT payload_hash, payload FROM events WHERE event_id = ? AND accepted = 1 ORDER BY id LIMIT 1",
        ).get(eventId) as { payload_hash: string | null; payload: string } | undefined;
        if (prior) {
          const priorHash = prior.payload_hash ?? payloadHash(JSON.parse(prior.payload));
          duplicate = priorHash === hash;
          conflict = !duplicate;
        }
      }

      const accepted = options.trusted && !duplicate && !conflict;
      let seqNote = "";
      if (accepted && seq !== null) {
        if (lastSeq !== null && seq !== lastSeq + 1) seqNote = `expected ${lastSeq + 1}, got ${seq}`;
        if (lastSeq === null || seq > lastSeq) {
          lastSeq = seq;
          this.db.prepare(`INSERT INTO webhook_sequence (profile, last_seq) VALUES (?, ?)
            ON CONFLICT(profile) DO UPDATE SET last_seq = excluded.last_seq`).run(options.profile, seq);
        }
      }

      const reason = !options.trusted ? options.rejectionReason ?? "untrusted signature" :
        duplicate ? "duplicate event id" : conflict ? "event id reused with different payload" : null;
      this.insertEvent({
        ...event,
        _received_at: options.receivedAt,
        _sig: options.sig,
        _accepted: accepted,
        _duplicate: duplicate,
        _conflict: conflict,
        _seq_note: seqNote,
        _payload_hash: hash,
        _raw_body: options.rawBody,
        _profile: options.profile,
        _rejection_reason: reason,
      });

      return { accept: accepted, duplicate, conflict, seqNote, lastSeq };
    }).immediate();
  }

  /** Persist malformed wire bodies too; they have no event ID or sequence authority. */
  recordMalformedWebhook(receivedAt: string, rawBody: string, profile: WebhookProfile): void {
    const payload = { raw_body: rawBody };
    this.insertEvent({
      EventClass: "malformed_webhook",
      _received_at: receivedAt,
      _sig: "malformed",
      _accepted: false,
      _duplicate: false,
      _conflict: false,
      _payload_hash: payloadHash(payload),
      _raw_body: rawBody,
      _profile: profile,
      _rejection_reason: "malformed JSON payload",
    });
  }

  lastWebhookSequence(profile: WebhookProfile): number | null {
    return this.readWebhookSequence(profile);
  }

  private readWebhookSequence(profile: WebhookProfile): number | null {
    const row = this.db.prepare("SELECT last_seq FROM webhook_sequence WHERE profile = ?").get(profile) as { last_seq: number | null } | undefined;
    return row?.last_seq ?? null;
  }

  private sequenceOf(value: unknown): number | null {
    const text = String(value ?? "");
    if (!/^\d+$/.test(text)) return null;
    const valueAsNumber = Number(text);
    return Number.isSafeInteger(valueAsNumber) ? valueAsNumber : null;
  }

  private insertEvent(r: EventRecord): void {
    const { _received_at, _sig, _duplicate, _accepted, _seq_note, ...payload } = r;
    const { _conflict, _payload_hash, _raw_body, _profile, _rejection_reason, ...simPayload } = payload;
    const seq = this.sequenceOf(simPayload.SequenceId);
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    this.insEvent.run({
      event_id: text(simPayload.EventId),
      seq,
      event_class: simPayload.EventClass ?? "?",
      plate: text(simPayload.CarPlateNumber),
      spot: text(simPayload.SpotName),
      spot_type: text(simPayload.SpotType),
      direction: text(simPayload.Direction),
      received_at: _received_at,
      received_ms: Date.parse(_received_at),
      sig: _sig ?? null,
      accepted: _accepted === false ? 0 : 1,
      duplicate: _duplicate ? 1 : 0,
      conflict: _conflict ? 1 : 0,
      payload_hash: _payload_hash ?? payloadHash(simPayload),
      raw_body: _raw_body ?? null,
      profile: _profile ?? "level1",
      rejection_reason: _rejection_reason ?? null,
      payload: JSON.stringify(simPayload),
    });
  }

  recordSession(s: SessionView): void {
    const visitId = s.visit_id ?? this.getOrCreateVisitId(null, s.plate, s.arrived_at);
    const data = { ...s, visit_id: visitId };
    this.insSession.run({
      ...s, visit_id: visitId, run_id: null,
      payment_ok: s.payment_ok === null ? null : s.payment_ok ? 1 : 0,
      recorded_at: new Date().toISOString(),
      data: JSON.stringify(data),
    });
    this.closeVisit(visitId, s.status, data);
  }

  getOrCreateVisitId(eventId: string | null | undefined, plate: string, startedAt?: string | null, replaceActive = false): string {
    if (eventId) {
      const found = this.db.prepare("SELECT visit_id FROM visits WHERE entry_event_id = ?").get(eventId) as { visit_id: string } | undefined;
      if (found) return found.visit_id;
    }
    const active = this.db.prepare("SELECT visit_id FROM visits WHERE plate = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get(plate) as { visit_id: string } | undefined;
    if (active && !replaceActive) return active.visit_id;
    if (active) this.closeVisit(active.visit_id, "superseded", { reason: "a new entry event established a new visit" });
    const id = randomUUID(), at = startedAt && Number.isFinite(Date.parse(startedAt)) ? startedAt : new Date().toISOString();
    this.db.prepare(`INSERT INTO visits (visit_id, entry_event_id, plate, status, started_at, updated_at, data)
      VALUES (?, ?, ?, 'unknown', ?, ?, '{}')`).run(id, eventId || null, plate, at, new Date().toISOString());
    return id;
  }

  saveVisitState(state: { visit_id?: string; plate: string; status: string; arrived_at?: string | null }): void {
    const visitId = state.visit_id ?? this.getOrCreateVisitId(null, state.plate, state.arrived_at);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO visits (visit_id, plate, status, started_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(visit_id) DO UPDATE SET status = excluded.status,
      updated_at = excluded.updated_at, data = excluded.data`)
      .run(visitId, state.plate, state.status, state.arrived_at ?? now, now, JSON.stringify(state));
  }

  activeVisitStates(): { visit_id: string; plate: string; status: string; updated_at: string; data: Record<string, unknown> }[] {
    const rows = this.db.prepare("SELECT visit_id, plate, status, updated_at, data FROM visits WHERE ended_at IS NULL ORDER BY started_at")
      .all() as { visit_id: string; plate: string; status: string; updated_at: string; data: string }[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  closeVisit(visitId: string, status: string, state: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE visits SET status = ?, updated_at = ?, ended_at = ?, data = ? WHERE visit_id = ?")
      .run(status, now, now, JSON.stringify(state), visitId);
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
      `SELECT id, received_at, event_class, plate, spot, direction, sig, accepted, duplicate, conflict, rejection_reason, payload FROM events
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @limit`,
    ).all(params) as {
      id: number; received_at: string; event_class: string; plate: string | null; spot: string | null; direction: string | null;
      sig: string | null; accepted: number; duplicate: number; conflict: number; rejection_reason: string | null; payload: string;
    }[];
    return rows.map((r) => ({ id: r.id, received_at: r.received_at, event_class: r.event_class, plate: r.plate,
      spot: r.spot, direction: r.direction, sig: r.sig, accepted: !!r.accepted, duplicate: !!r.duplicate,
      conflict: !!r.conflict, rejection_reason: r.rejection_reason, payload: JSON.parse(r.payload) }));
  }

  /** Penalties are simulator facts only: rejected, duplicate, and EventId-conflict deliveries are excluded. */
  searchAcceptedPenalties(opts: { sinceMs?: number; untilMsExclusive?: number; plate?: string; component?: string; zone?: string;
    reason?: string; resolutionStatus?: PenaltyResolutionStatus; limit?: number }): PenaltyView[] {
    const where = ["e.event_class = 'penalty'", "e.accepted = 1", "e.duplicate = 0", "e.conflict = 0"];
    const params: Record<string, unknown> = { limit: Math.max(1, Math.min(opts.limit ?? 100, 1000)) };
    if (opts.sinceMs !== undefined) { where.push("e.received_ms >= @sinceMs"); params.sinceMs = opts.sinceMs; }
    if (opts.untilMsExclusive !== undefined) { where.push("e.received_ms < @untilMsExclusive"); params.untilMsExclusive = opts.untilMsExclusive; }
    if (opts.plate) {
      where.push("coalesce(e.plate, CASE WHEN json_extract(e.payload, '$.Type') = 'Car' THEN json_extract(e.payload, '$.ComponentName') END) LIKE @plate");
      params.plate = `%${opts.plate}%`;
    }
    if (opts.component) { where.push("json_extract(e.payload, '$.ComponentName') LIKE @component"); params.component = `%${opts.component}%`; }
    if (opts.zone) { where.push("coalesce(json_extract(e.payload, '$.ZoneName'), json_extract(e.payload, '$.ZoneParent'), json_extract(e.payload, '$.Zone')) LIKE @zone"); params.zone = `%${opts.zone}%`; }
    if (opts.reason) { where.push("json_extract(e.payload, '$.Reason') LIKE @reason"); params.reason = `%${opts.reason}%`; }
    const linkedStatus = `coalesce((SELECT i.status FROM incidents i WHERE e.event_id IS NOT NULL AND
      (i.correlation_key = e.event_id OR json_extract(i.details, '$.event_id') = e.event_id OR
       json_extract(i.details, '$.penalty_event_id') = e.event_id) ORDER BY i.opened_at DESC LIMIT 1), 'unlinked')`;
    if (opts.resolutionStatus) { where.push(`${linkedStatus} = @resolutionStatus`); params.resolutionStatus = opts.resolutionStatus; }
    const rows = this.db.prepare(`SELECT e.id, e.event_id, e.received_at, e.plate, e.payload,
      (SELECT i.id FROM incidents i WHERE e.event_id IS NOT NULL AND
        (i.correlation_key = e.event_id OR json_extract(i.details, '$.event_id') = e.event_id OR
         json_extract(i.details, '$.penalty_event_id') = e.event_id) ORDER BY i.opened_at DESC LIMIT 1) incident_id,
      ${linkedStatus} incident_status
      FROM events e WHERE ${where.join(" AND ")} ORDER BY e.received_ms DESC, e.id DESC LIMIT @limit`).all(params) as {
        id: number; event_id: string | null; received_at: string; plate: string | null; payload: string;
        incident_id: string | null; incident_status: string;
      }[];
    return rows.map((row) => this.toPenaltyView(row));
  }

  /**
   * Return a deliberately narrow evidence projection for one accepted, deduplicated penalty.
   * The webhook signature, payload, raw body, and rejection metadata are never selected here.
   */
  acceptedPenaltyDetail(id: number): PenaltyDetailView | undefined {
    const row = this.db.prepare(`SELECT e.id, e.event_id, e.received_at, e.received_ms, e.plate, e.payload,
      (SELECT i.id FROM incidents i WHERE e.event_id IS NOT NULL AND
        (i.correlation_key = e.event_id OR json_extract(i.details, '$.event_id') = e.event_id OR
         json_extract(i.details, '$.penalty_event_id') = e.event_id) ORDER BY i.opened_at DESC LIMIT 1) incident_id,
      coalesce((SELECT i.status FROM incidents i WHERE e.event_id IS NOT NULL AND
        (i.correlation_key = e.event_id OR json_extract(i.details, '$.event_id') = e.event_id OR
         json_extract(i.details, '$.penalty_event_id') = e.event_id) ORDER BY i.opened_at DESC LIMIT 1), 'unlinked') incident_status
      FROM events e WHERE e.id = ? AND e.event_class = 'penalty' AND e.accepted = 1 AND e.duplicate = 0 AND e.conflict = 0`)
      .get(id) as { id: number; event_id: string | null; received_at: string; received_ms: number; plate: string | null;
        payload: string; incident_id: string | null; incident_status: string } | undefined;
    if (!row) return undefined;

    const penalty = this.toPenaltyView(row);
    const windowStart = row.received_ms - 2 * 60_000;
    const windowEnd = row.received_ms + 2 * 60_000;
    const nearbyEventRows = this.db.prepare(`SELECT id, event_id, received_at, event_class, plate, spot, direction
      FROM events WHERE accepted = 1 AND duplicate = 0 AND conflict = 0 AND received_ms BETWEEN ? AND ?
      ORDER BY abs(received_ms - ?), id LIMIT 20`).all(windowStart, windowEnd, row.received_ms) as {
        id: number; event_id: string | null; received_at: string; event_class: string; plate: string | null;
        spot: string | null; direction: string | null;
      }[];
    const nearbyEvents: PenaltyEvidenceEvent[] = nearbyEventRows.map((event) => ({ ...event }));
    nearbyEvents.sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id - b.id);

    const commandFrom = new Date(windowStart).toISOString(), commandTo = new Date(windowEnd).toISOString();
    const actionRows = this.db.prepare(`SELECT id, at, cmd, args, actor, ok FROM actions
      WHERE at BETWEEN ? AND ? ORDER BY id DESC LIMIT 20`).all(commandFrom, commandTo) as {
        id: number; at: string; cmd: string; args: string; actor: string | null; ok: number;
      }[];
    const intentRows = this.db.prepare(`SELECT id, at, cmd, args, actor, status FROM command_intents
      WHERE at BETWEEN ? AND ? ORDER BY at DESC, rowid DESC LIMIT 20`).all(commandFrom, commandTo) as {
        id: string; at: string; cmd: string; args: string; actor: string | null; status: string;
      }[];
    const nearbyCommands: PenaltyEvidenceCommand[] = [
      ...actionRows.map((action) => ({ id: String(action.id), source: "action" as const, at: action.at,
        cmd: action.cmd, args: commandArgs(action.args), actor: action.actor, outcome: action.ok ? "succeeded" : "failed" })),
      ...intentRows.map((intent) => ({ id: intent.id, source: "command_intent" as const, at: intent.at,
        cmd: intent.cmd, args: commandArgs(intent.args), actor: intent.actor, outcome: intent.status })),
    ].sort((a, b) => Math.abs(Date.parse(a.at) - row.received_ms) - Math.abs(Date.parse(b.at) - row.received_ms)
      || a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(0, 20);

    let relatedVisit: PenaltyRelatedVisit | null = null;
    let visitLink: PenaltyDetailView["visit_link"] = "none";
    if (penalty.plate) {
      const visitRows = this.db.prepare(`SELECT visit_id, plate, status, started_at, ended_at, data FROM visits
        WHERE plate = ? AND julianday(started_at) <= julianday(?) AND
          julianday(coalesce(ended_at, updated_at)) >= julianday(?) ORDER BY started_at DESC LIMIT 3`)
        .all(penalty.plate, new Date(windowEnd).toISOString(), new Date(windowStart).toISOString()) as {
          visit_id: string; plate: string; status: string; started_at: string; ended_at: string | null; data: string;
        }[];
      if (visitRows.length === 1) {
        const visit = visitRows[0];
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(visit.data) as Record<string, unknown>; } catch { /* retain safe null component fields */ }
        const field = (key: string) => typeof data[key] === "string" ? data[key] as string : null;
        relatedVisit = { visit_id: visit.visit_id, plate: visit.plate, status: visit.status, started_at: visit.started_at,
          ended_at: visit.ended_at, spot: field("spot"), entry_lane: field("entry_lane"), exit_lane: field("exit_lane") };
        visitLink = "linked";
      } else if (visitRows.length > 1) visitLink = "ambiguous";
    }

    let linkedIncident: PenaltyLinkedIncident | null = null;
    if (row.event_id) {
      const incident = this.db.prepare(`SELECT id, type, status, severity, summary, opened_at, updated_at, resolved_at,
        component, component_type, zone, reason FROM incidents WHERE correlation_key = ? OR
        json_extract(details, '$.event_id') = ? OR json_extract(details, '$.penalty_event_id') = ?
        ORDER BY opened_at DESC LIMIT 1`).get(row.event_id, row.event_id, row.event_id) as {
          id: string; type: string; status: IncidentStatus; severity: IncidentSeverity; summary: string; opened_at: string;
          updated_at: string; resolved_at: string | null; component: string | null; component_type: string | null;
          zone: string | null; reason: string | null;
        } | undefined;
      if (incident) linkedIncident = { ...incident, latest_note: incident.reason };
    }

    return {
      penalty, related_visit: relatedVisit, visit_link: visitLink,
      related_component: penalty.component ? { name: penalty.component, simulator_type: penalty.simulator_component_type, zone: penalty.zone } : null,
      nearby_events: nearbyEvents, nearby_commands: nearbyCommands,
      suspected_cause: { assessment: "undetermined", confidence: "unknown",
        explanation: "No causal diagnosis is established. Nearby events are contextual evidence and may not explain why the simulator issued this penalty." },
      recovery_action: { status: "unverified",
        explanation: "No physical recovery is inferred from command history. Nearby commands show recorded attempts only; a subsequent accepted simulator observation is needed to verify recovery." },
      linked_incident: linkedIncident,
    };
  }

  private toPenaltyView(row: { id: number; event_id: string | null; received_at: string; plate: string | null; payload: string;
    incident_id: string | null; incident_status: string }): PenaltyView {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const kind = payloadText(p, "Type");
    const componentName = payloadText(p, "ComponentName");
    const isCar = kind?.toLowerCase() === "car";
    const fineRaw = p.FineAmount === undefined || p.FineAmount === null ? null : String(p.FineAmount);
    const resolution = row.incident_status === "open" || row.incident_status === "acknowledged" || row.incident_status === "resolved"
      ? row.incident_status : "unlinked";
    return {
      id: row.id, event_id: row.event_id, received_at: row.received_at,
      plate: row.plate ?? (isCar ? componentName : null), component: isCar ? null : componentName,
      simulator_component_type: kind, zone: payloadText(p, "ZoneName", "ZoneParent", "Zone"),
      message: payloadText(p, "Reason"), fine_amount_raw: fineRaw,
      fine_minor: simulatorAmountMinor(p.FineAmount), incident_id: row.incident_id,
      resolution_status: resolution as PenaltyResolutionStatus, run_id: null,
    };
  }

  /** Daily counts from persisted accepted facts. Time boundaries are server UTC, not simulator calendar. */
  dailyReportFacts(sinceMs: number, untilMsExclusive: number, generatedAt: string): {
    operational: DailyReportOperational; financial: DailyReportFinancial; unavailableMetrics: string[];
  } {
    const since = new Date(sinceMs).toISOString(), until = new Date(untilMsExclusive).toISOString();
    const eventCounts = this.db.prepare(`SELECT
      sum(CASE WHEN spot_type = 'EntrySpot' AND direction = 'CarIn' THEN 1 ELSE 0 END) arrivals,
      sum(CASE WHEN spot_type = 'Park' AND direction = 'CarIn' THEN 1 ELSE 0 END) admissions,
      sum(CASE WHEN event_class = 'penalty' THEN 1 ELSE 0 END) penalties,
      sum(CASE WHEN event_class = 'component_broken' THEN 1 ELSE 0 END) failures,
      sum(CASE WHEN event_class = 'component_fixed' THEN 1 ELSE 0 END) recoveries,
      sum(CASE WHEN event_class = 'carbon_monoxide_event' THEN 1 ELSE 0 END) co_events
      FROM events WHERE accepted = 1 AND duplicate = 0 AND conflict = 0 AND received_ms >= ? AND received_ms < ?`)
      .get(sinceMs, untilMsExclusive) as { arrivals: number | null; admissions: number | null; penalties: number | null;
        failures: number | null; recoveries: number | null; co_events: number | null };
    // The Level 2 webhook contract exposes CarbonMonoxideLevel. Preserve null if
    // the event is malformed or the simulator omits the numeric reading rather
    // than presenting a made-up zero.
    const coRows = this.db.prepare(`SELECT payload FROM events
      WHERE accepted = 1 AND duplicate = 0 AND conflict = 0 AND event_class = 'carbon_monoxide_event'
        AND received_ms >= ? AND received_ms < ?`).all(sinceMs, untilMsExclusive) as { payload: string }[];
    const coReadings = coRows.map(({ payload }) => {
      const value = (JSON.parse(payload) as Record<string, unknown>).CarbonMonoxideLevel;
      if (typeof value !== "number" && typeof value !== "string") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }).filter((value): value is number => value !== null);
    const sessionCounts = this.db.prepare(`SELECT
      sum(CASE WHEN status = 'gone' THEN 1 ELSE 0 END) departures,
      sum(CASE WHEN status = 'turned_away' THEN 1 ELSE 0 END) turnaways,
      sum(CASE WHEN status = 'neglected' THEN 1 ELSE 0 END) abandoned,
      sum(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) lost
      FROM sessions WHERE recorded_at >= ? AND recorded_at < ?`).get(since, until) as {
        departures: number | null; turnaways: number | null; abandoned: number | null; lost: number | null;
      };

    const invoices = this.db.prepare(`SELECT status, total_minor FROM invoices WHERE created_at >= ? AND created_at < ?`)
      .all(since, until) as { status: string; total_minor: number }[];
    const issued = invoices.filter((i) => i.status === "issued" || i.status === "settled").length;
    const outstanding = invoices.filter((i) => i.status === "pending" || i.status === "issued" || i.status === "outcome_unknown").length;
    const uncertain = invoices.filter((i) => i.status === "outcome_unknown").length;
    const waived = invoices.filter((i) => i.status === "waived");
    const adjustments = this.listFinancialAdjustments().filter((a) => {
      const at = Date.parse(a.at);
      return Number.isFinite(at) && at >= sinceMs && at < untilMsExclusive;
    });
    const adjustmentsOf = (kind: FinancialAdjustmentKind) => adjustments.filter((a) => a.kind === kind);
    const adjustmentAmount = (kind: FinancialAdjustmentKind) => adjustmentsOf(kind).reduce((sum, a) => sum + a.amount_minor, 0);

    // Payment-day attribution comes from accepted payment events; only settle-matched invoices count as verified.
    const payments = this.db.prepare(`SELECT e.event_id, i.paid_minor FROM events e JOIN invoices i ON i.payment_event_id = e.event_id
      WHERE e.event_class = 'payment_made' AND e.accepted = 1 AND e.duplicate = 0 AND e.conflict = 0
        AND e.event_id IS NOT NULL AND i.status = 'settled' AND e.received_ms >= ? AND e.received_ms < ?`)
      .all(sinceMs, untilMsExclusive) as { event_id: string; paid_minor: number | null }[];
    const uniquePayments = new Map<string, number>();
    for (const p of payments) if (p.paid_minor !== null && !uniquePayments.has(p.event_id)) uniquePayments.set(p.event_id, p.paid_minor);
    const verifiedPaymentsMinor = [...uniquePayments.values()].reduce((sum, amount) => sum + amount, 0);

    const penaltyRows = this.db.prepare(`SELECT payload FROM events WHERE event_class = 'penalty' AND accepted = 1 AND duplicate = 0 AND conflict = 0
      AND received_ms >= ? AND received_ms < ?`).all(sinceMs, untilMsExclusive) as { payload: string }[];
    let knownFinesMinor = 0, unknownFineCount = 0;
    for (const row of penaltyRows) {
      const p = JSON.parse(row.payload) as Record<string, unknown>;
      const amount = simulatorAmountMinor(p.FineAmount);
      if (amount === null) unknownFineCount++;
      else knownFinesMinor += amount;
    }

    const operational: DailyReportOperational = {
      arrivals: eventCounts.arrivals ?? 0, admissions: eventCounts.admissions ?? 0,
      completed_departures: sessionCounts.departures ?? 0, turnaways: sessionCounts.turnaways ?? 0,
      abandoned_visits: sessionCounts.abandoned ?? 0, lost_visits: sessionCounts.lost ?? 0,
      accepted_simulator_penalties: eventCounts.penalties ?? 0,
      component_failure_events: eventCounts.failures ?? 0, component_recovery_events: eventCounts.recoveries ?? 0,
      co_events: eventCounts.co_events ?? 0, peak_co_level: coReadings.length ? coReadings.reduce((max, value) => Math.max(max, value), 0) : null,
    };
    const financial: DailyReportFinancial = {
      invoices_created: invoices.length, invoices_issued_current_status: issued,
      verified_payments_count: uniquePayments.size, verified_payments_minor: verifiedPaymentsMinor,
      outstanding_invoices_current_status: outstanding, uncertain_payment_outcomes_current_status: uncertain,
      waived_invoices_current_status: waived.length, waived_total_minor_current_status: waived.reduce((sum, i) => sum + i.total_minor, 0),
      financial_adjustments_count: adjustmentsOf("adjustment").length,
      financial_adjustments_amount_minor_recorded: adjustmentAmount("adjustment"),
      waiver_records_count: adjustmentsOf("waiver").length, waiver_amount_minor_recorded: adjustmentAmount("waiver"),
      emergency_release_records_count: adjustmentsOf("emergency_release").length,
      emergency_release_amount_minor_recorded: adjustmentAmount("emergency_release"),
      known_simulator_fines_minor: knownFinesMinor, unknown_simulator_fine_amount_count: unknownFineCount,
      receipts_after_known_simulator_fines_minor: unknownFineCount ? null : verifiedPaymentsMinor - knownFinesMinor,
      financial_state_as_of: generatedAt,
    };
    return { operational, financial, unavailableMetrics: [
      "Simulator calendar day and simulator run identity (no calibrated calendar/run boundary is persisted).",
      "Occupancy, reservations, uncertainty, and unavailable-capacity intervals (no durable interval history).",
      "Queue and exit waiting durations (no persisted queue interval history).",
      "Equipment runtime/downtime, ventilation runtime, lighting runtime, and repair duration (event counts alone do not measure intervals).",
      ...(coReadings.length ? [] : ["Peak CO reading is unavailable because accepted CO events contain no valid numeric CarbonMonoxideLevel."]),
      "Overdue maintenance, unverified exits, unresolved incidents, and command failures (not attributed to this persisted day by this query).",
      "Repair costs (no repair-cost ledger is available).",
      "Invoice status transitions outside the current status and any waiver not represented by a financial-adjustment ledger entry.",
    ] };
  }

  recordLoginAttempt(attempt: LoginAttemptRecord): number {
    const at = attempt.at ?? new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO login_attempts
      (attempted_at, attempted_ms, attempted_username, user_id, success, category, source_ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(at, Date.parse(at), attempt.username, attempt.userId ?? null, attempt.success ? 1 : 0,
        attempt.category, attempt.sourceIp ?? null, attempt.userAgent ?? null);
    return Number(result.lastInsertRowid);
  }

  previousLoginAttempts(userId: number, beforeId: number, limit = 3) {
    const rows = this.db.prepare(`SELECT id, attempted_at, attempted_username, success, category, source_ip
      FROM login_attempts WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(userId, beforeId, Math.max(1, Math.min(limit, 20))) as {
        id: number; attempted_at: string; attempted_username: string; success: number; category: string; source_ip: string | null;
      }[];
    return rows.map((r) => ({ id: r.id, attempted_at: r.attempted_at, username: r.attempted_username,
      success: !!r.success, category: r.category, source_ip: r.source_ip }));
  }

  recentLoginAttemptsForUser(userId: number, limit = 3) {
    const rows = this.db.prepare(`SELECT id, attempted_at, attempted_username, success, category, source_ip
      FROM login_attempts WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
      .all(userId, Math.max(1, Math.min(limit, 20))) as {
        id: number; attempted_at: string; attempted_username: string; success: number; category: string; source_ip: string | null;
      }[];
    return rows.map((r) => ({ id: r.id, attempted_at: r.attempted_at, username: r.attempted_username,
      success: !!r.success, category: r.category, source_ip: r.source_ip }));
  }

  recentLoginAttempts(limit = 100) {
    const rows = this.db.prepare(`SELECT id, attempted_at, attempted_username, user_id, success, category, source_ip
      FROM login_attempts ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 1000))) as {
        id: number; attempted_at: string; attempted_username: string; user_id: number | null; success: number; category: string; source_ip: string | null;
      }[];
    return rows.map((r) => ({ id: r.id, attempted_at: r.attempted_at, username: r.attempted_username,
      user_id: r.user_id, success: !!r.success, category: r.category, source_ip: r.source_ip }));
  }

  recordAudit(entry: AuditRecord): number {
    const at = entry.at ?? new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO audit_log (at, actor_id, actor_username, action, target, reason, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(at, entry.actorId ?? null, entry.actorUsername ?? null, entry.action, entry.target ?? null,
        entry.reason ?? null, JSON.stringify(entry.details ?? {}));
    return Number(result.lastInsertRowid);
  }

  latestSimulatorCalendarRecord(): PersistedSimulatorCalendarRecord | null {
    const row = this.db.prepare(`SELECT action, run_id, simulator_time_iso, real_anchor_ms,
      calendar_seconds_per_real_second, day_start_minute, night_start_minute, process_instance_token,
      reason, recorded_at FROM simulator_calendar_records ORDER BY id DESC LIMIT 1`).get() as {
        action: "anchor" | "invalidate"; run_id: string | null; simulator_time_iso: string | null;
        real_anchor_ms: number | null; calendar_seconds_per_real_second: number | null;
        day_start_minute: number | null; night_start_minute: number | null; process_instance_token: string | null;
        reason: string; recorded_at: string;
      } | undefined;
    if (!row) return null;
    if (row.action === "invalidate") {
      return { action: "invalidate", runId: row.run_id, reason: row.reason, recordedAt: row.recorded_at };
    }
    if (row.run_id === null || row.simulator_time_iso === null || row.real_anchor_ms === null ||
      row.calendar_seconds_per_real_second === null || row.day_start_minute === null || row.night_start_minute === null ||
      row.process_instance_token === null) return null;
    return {
      action: "anchor", runId: row.run_id, simulatorTimeIso: row.simulator_time_iso, realAnchorMs: row.real_anchor_ms,
      calendarSecondsPerRealSecond: row.calendar_seconds_per_real_second, dayStartMinute: row.day_start_minute,
      nightStartMinute: row.night_start_minute, processInstanceToken: row.process_instance_token,
      reason: row.reason, recordedAt: row.recorded_at,
    };
  }

  appendSimulatorCalendarRecord(input: SimulatorCalendarWriteRecord, audit: SimulatorCalendarAuditContext): PersistedSimulatorCalendarRecord {
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const row = input.action === "anchor"
        ? this.db.prepare(`INSERT INTO simulator_calendar_records (action, run_id, simulator_time_iso, real_anchor_ms,
            calendar_seconds_per_real_second, day_start_minute, night_start_minute, process_instance_token,
            reason, actor_id, actor_username, recorded_at)
          VALUES ('anchor', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.runId, input.simulatorTimeIso, input.realAnchorMs, input.calendarSecondsPerRealSecond,
            input.dayStartMinute, input.nightStartMinute, input.processInstanceToken, input.reason,
            audit.actorId, audit.actorUsername, recordedAt)
        : this.db.prepare(`INSERT INTO simulator_calendar_records (action, run_id, reason, actor_id, actor_username, recorded_at)
          VALUES ('invalidate', ?, ?, ?, ?, ?)`)
          .run(input.runId, input.reason, audit.actorId, audit.actorUsername, recordedAt);
      const id = Number(row.lastInsertRowid);
      this.recordAudit({ actorId: audit.actorId, actorUsername: audit.actorUsername,
        action: `simulator_clock.${input.action}`, target: input.runId, reason: input.reason, at: recordedAt,
        details: { record_id: id, before: audit.before, after: audit.after } });
      return id;
    });
    const id = transaction();
    return this.simulatorCalendarRecord(id)!;
  }

  private simulatorCalendarRecord(id: number): PersistedSimulatorCalendarRecord | null {
    const row = this.db.prepare(`SELECT action, run_id, simulator_time_iso, real_anchor_ms,
      calendar_seconds_per_real_second, day_start_minute, night_start_minute, process_instance_token,
      reason, recorded_at FROM simulator_calendar_records WHERE id = ?`).get(id) as {
        action: "anchor" | "invalidate"; run_id: string | null; simulator_time_iso: string | null;
        real_anchor_ms: number | null; calendar_seconds_per_real_second: number | null;
        day_start_minute: number | null; night_start_minute: number | null; process_instance_token: string | null;
        reason: string; recorded_at: string;
      } | undefined;
    if (!row) return null;
    if (row.action === "invalidate") return { action: "invalidate", runId: row.run_id, reason: row.reason, recordedAt: row.recorded_at };
    if (row.run_id === null || row.simulator_time_iso === null || row.real_anchor_ms === null ||
      row.calendar_seconds_per_real_second === null || row.day_start_minute === null || row.night_start_minute === null ||
      row.process_instance_token === null) return null;
    return { action: "anchor", runId: row.run_id, simulatorTimeIso: row.simulator_time_iso,
      realAnchorMs: row.real_anchor_ms, calendarSecondsPerRealSecond: row.calendar_seconds_per_real_second,
      dayStartMinute: row.day_start_minute, nightStartMinute: row.night_start_minute,
      processInstanceToken: row.process_instance_token, reason: row.reason, recordedAt: row.recorded_at };
  }

  startCommandIntent(cmd: string, args: (string | number)[], actor: string | null = null): string {
    const id = randomUUID(), at = new Date().toISOString();
    this.db.prepare(`INSERT INTO command_intents (id, at, updated_at, cmd, args, actor, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(id, at, at, cmd, JSON.stringify(args.map(String)), actor);
    return id;
  }

  finishCommandIntent(id: string, status: Exclude<CommandIntentStatus, "pending" | "confirmed">, error: string | null = null): void {
    this.db.prepare("UPDATE command_intents SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, error, new Date().toISOString(), id);
  }

  confirmCommandIntent(cmd: string, argsPrefix: string[]): boolean {
    const rows = this.db.prepare("SELECT id, args FROM command_intents WHERE cmd = ? AND status = 'acknowledged' ORDER BY at DESC, rowid DESC")
      .all(cmd) as { id: string; args: string }[];
    const match = rows.find((row) => {
      const args = JSON.parse(row.args) as string[];
      return argsPrefix.every((value, index) => args[index] === value);
    });
    if (!match) return false;
    const result = this.db.prepare("UPDATE command_intents SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'acknowledged'")
      .run(new Date().toISOString(), match.id);
    return result.changes > 0;
  }

  markInterruptedCommandIntentsUnknown(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE command_intents SET status = 'outcome_unknown',
      error = 'process stopped before outcome was persisted', updated_at = ? WHERE status = 'pending'`).run(now);
    const count = Number(result.changes);
    if (count) this.recordAudit({ actorUsername: "system", action: "command.recovery.unknown", details: { count } });
    return count;
  }

  listCommandIntents(limit = 100): CommandIntentView[] {
    const rows = this.db.prepare("SELECT * FROM command_intents ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 1000))) as {
        id: string; at: string; updated_at: string; cmd: string; args: string; actor: string | null;
        status: CommandIntentStatus; error: string | null;
      }[];
    return rows.map((row) => ({ id: row.id, at: row.at, updated_at: row.updated_at, cmd: row.cmd,
      args: JSON.parse(row.args) as string[], actor: row.actor, status: row.status, error: row.error }));
  }

  /** Latest repair request for a component that could belong to a persisted maintenance job. */
  repairCommandSince(component: string, since: string): CommandIntentView | undefined {
    const row = this.db.prepare(`SELECT * FROM command_intents WHERE cmd = 'repair' AND at >= ?
      AND json_extract(args, '$[0]') = ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(since, component) as {
        id: string; at: string; updated_at: string; cmd: string; args: string; actor: string | null;
        status: CommandIntentStatus; error: string | null;
      } | undefined;
    return row ? { id: row.id, at: row.at, updated_at: row.updated_at, cmd: row.cmd, args: JSON.parse(row.args),
      actor: row.actor, status: row.status, error: row.error } : undefined;
  }

  createOrUpdateIncident(input: CreateIncident): IncidentView {
    const key = input.correlationKey ?? null;
    const existing = key ? this.db.prepare(`SELECT * FROM incidents WHERE type = ? AND correlation_key = ?
      AND status != 'resolved' ORDER BY opened_at DESC LIMIT 1`).get(input.type, key) as Record<string, unknown> | undefined : undefined;
    const now = new Date().toISOString();
    if (existing) {
      const merged = { ...(JSON.parse(String(existing.details)) as Record<string, unknown>), ...(input.details ?? {}) };
      this.db.prepare(`UPDATE incidents SET severity = ?, summary = ?, updated_at = ?, details = ? WHERE id = ?`)
        .run(input.severity, input.summary, now, JSON.stringify(merged), existing.id);
      return this.getIncident(String(existing.id))!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO incidents (id, type, correlation_key, severity, status, summary, opened_at, updated_at,
      plate, component, component_type, zone, lane, reason, details)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.type, key, input.severity, input.summary, now, now, input.plate ?? null, input.component ?? null,
        input.componentType ?? null, input.zone ?? null, input.lane ?? null, input.reason ?? null, JSON.stringify(input.details ?? {}));
    return this.getIncident(id)!;
  }

  getIncident(id: string): IncidentView | undefined {
    const row = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toIncident(row) : undefined;
  }

  getIncidentByCorrelation(type: string, correlationKey: string): IncidentView | undefined {
    const row = this.db.prepare(`SELECT * FROM incidents WHERE type = ? AND correlation_key = ? AND status != 'resolved'
      ORDER BY opened_at DESC LIMIT 1`).get(type, correlationKey) as Record<string, unknown> | undefined;
    return row ? this.toIncident(row) : undefined;
  }

  listIncidents(opts: { status?: IncidentStatus; equipmentOnly?: boolean; limit?: number } = {}): IncidentView[] {
    const where: string[] = [], params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.equipmentOnly) where.push("component IS NOT NULL");
    params.push(Math.max(1, Math.min(opts.limit ?? 100, 1000)));
    const rows = this.db.prepare(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, opened_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.toIncident(row));
  }

  updateIncident(id: string, status: IncidentStatus, actor: string, reason: string): IncidentView | undefined {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE incidents SET status = ?, updated_at = ?, resolved_at = ?, reason = ? WHERE id = ?`)
      .run(status, now, status === "resolved" ? now : null, reason, id);
    return this.getIncident(id);
  }

  /** Persist the latest accepted CO observation and its fail-safe zone restriction. */
  saveCoZoneState(state: CoZoneSafetyState): void {
    this.db.prepare(`INSERT INTO co_zone_state (zone, updated_at, state) VALUES (?, ?, ?)
      ON CONFLICT(zone) DO UPDATE SET updated_at = excluded.updated_at, state = excluded.state`)
      .run(state.zone, new Date().toISOString(), JSON.stringify(state));
  }

  coZoneStates(): CoZoneSafetyState[] {
    const rows = this.db.prepare("SELECT state FROM co_zone_state ORDER BY zone").all() as { state: string }[];
    return rows.map((row) => JSON.parse(row.state) as CoZoneSafetyState);
  }

  /** Latest accepted component signal: true=broken, false=fixed, null=no evidence. */
  latestComponentBroken(simulatorType: string, name: string): boolean | null {
    const row = this.db.prepare(`SELECT event_class FROM events WHERE accepted = 1 AND duplicate = 0 AND conflict = 0
      AND event_class IN ('component_broken', 'component_fixed')
      AND json_extract(payload, '$.Type') = ? AND json_extract(payload, '$.Name') = ?
      ORDER BY (seq IS NULL), seq DESC, received_ms DESC, id DESC LIMIT 1`).get(simulatorType, name) as { event_class: string } | undefined;
    return row ? row.event_class === "component_broken" : null;
  }

  /** Highest trusted sequence ever observed for this named component, used to ignore delayed state reversals. */
  latestComponentSequence(simulatorType: string, name: string): number | null {
    const row = this.db.prepare(`SELECT max(seq) AS seq FROM events WHERE accepted = 1 AND duplicate = 0 AND conflict = 0
      AND event_class IN ('component_broken', 'component_fixed')
      AND json_extract(payload, '$.Type') = ? AND json_extract(payload, '$.Name') = ?`).get(simulatorType, name) as { seq: number | null };
    return row.seq === null ? null : Number(row.seq);
  }

  resolveIncidentByCorrelation(type: string, correlationKey: string, actor: string, reason: string): void {
    const row = this.db.prepare(`SELECT id FROM incidents WHERE type = ? AND correlation_key = ? AND status != 'resolved'
      ORDER BY opened_at DESC LIMIT 1`).get(type, correlationKey) as { id: string } | undefined;
    if (!row) return;
    this.updateIncident(row.id, "resolved", actor, reason);
    this.recordAudit({ actorUsername: actor, action: "incident.resolved", target: row.id, reason,
      details: { type, correlation_key: correlationKey } });
  }

  createInvoice(input: { visitId: string; plate: string; parking: number; electricity: number; billingBasis: string }): InvoiceView {
    const toMinor = (amount: number) => {
      if (!Number.isFinite(amount) || amount < 0) throw new Error("invoice amounts must be finite and nonnegative");
      return Math.round(amount * 100);
    };
    const parking = toMinor(input.parking), electricity = toMinor(input.electricity);
    const revision = (this.db.prepare("SELECT coalesce(max(revision), 0) + 1 n FROM invoices WHERE visit_id = ?")
      .get(input.visitId) as { n: number }).n;
    const now = new Date().toISOString(), id = randomUUID();
    this.db.prepare(`INSERT INTO invoices (id, visit_id, plate, revision, parking_minor, electricity_minor, total_minor,
      billing_basis, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.visitId, input.plate, revision, parking, electricity, parking + electricity, input.billingBasis, now, now);
    return this.getInvoice(id)!;
  }

  getInvoice(id: string): InvoiceView | undefined {
    const row = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toInvoice(row) : undefined;
  }

  activeInvoice(visitId: string): InvoiceView | undefined {
    const row = this.db.prepare(`SELECT * FROM invoices WHERE visit_id = ? AND status IN ('pending', 'outcome_unknown', 'issued')
      ORDER BY revision DESC LIMIT 1`).get(visitId) as Record<string, unknown> | undefined;
    return row ? this.toInvoice(row) : undefined;
  }

  latestInvoice(visitId: string): InvoiceView | undefined {
    const row = this.db.prepare("SELECT * FROM invoices WHERE visit_id = ? ORDER BY revision DESC LIMIT 1")
      .get(visitId) as Record<string, unknown> | undefined;
    return row ? this.toInvoice(row) : undefined;
  }

  recordFinancialAdjustment(input: { requestId: string; visitId: string; invoiceId?: string | null; plate: string;
    kind: FinancialAdjustmentKind; amountMinor: number; reason: string; actor: string }): FinancialAdjustmentView {
    const existing = this.db.prepare("SELECT * FROM financial_adjustments WHERE request_id = ?").get(input.requestId) as Record<string, unknown> | undefined;
    if (existing) return this.toFinancialAdjustment(existing);
    const id = randomUUID(), at = new Date().toISOString();
    this.db.prepare(`INSERT INTO financial_adjustments (id, request_id, visit_id, invoice_id, plate, kind, amount_minor, reason, actor, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.requestId, input.visitId, input.invoiceId ?? null, input.plate,
        input.kind, input.amountMinor, input.reason.trim(), input.actor, at);
    return this.getFinancialAdjustment(id)!;
  }

  getFinancialAdjustment(id: string): FinancialAdjustmentView | undefined {
    const row = this.db.prepare("SELECT * FROM financial_adjustments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toFinancialAdjustment(row) : undefined;
  }

  financialAdjustmentByRequestId(requestId: string): FinancialAdjustmentView | undefined {
    const row = this.db.prepare("SELECT * FROM financial_adjustments WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
    return row ? this.toFinancialAdjustment(row) : undefined;
  }

  listFinancialAdjustments(visitId?: string): FinancialAdjustmentView[] {
    const rows = visitId
      ? this.db.prepare("SELECT * FROM financial_adjustments WHERE visit_id = ? ORDER BY at DESC").all(visitId) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM financial_adjustments ORDER BY at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => this.toFinancialAdjustment(row));
  }

  sessionByVisitId(visitId: string): SessionView | undefined {
    const row = this.db.prepare("SELECT data FROM sessions WHERE visit_id = ? ORDER BY id DESC LIMIT 1").get(visitId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as SessionView : undefined;
  }

  activeInvoiceForPlate(plate: string): InvoiceView | undefined {
    const row = this.db.prepare(`SELECT * FROM invoices WHERE plate = ? AND status IN ('pending', 'outcome_unknown', 'issued')
      ORDER BY created_at DESC LIMIT 1`).get(plate) as Record<string, unknown> | undefined;
    return row ? this.toInvoice(row) : undefined;
  }

  activeInvoices(): InvoiceView[] {
    const rows = this.db.prepare("SELECT * FROM invoices WHERE status IN ('pending', 'outcome_unknown', 'issued') ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.toInvoice(row));
  }

  updateInvoiceStatus(id: string, status: InvoiceStatus): void {
    this.db.prepare("UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  settleInvoice(id: string, paidAmount: number, paymentEventId: string | null): boolean {
    const paidMinor = Math.round(paidAmount * 100);
    const result = this.db.prepare(`UPDATE invoices SET status = 'settled', paid_minor = ?, payment_event_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'outcome_unknown', 'issued')`)
      .run(paidMinor, paymentEventId, new Date().toISOString(), id);
    return result.changes > 0;
  }

  private toInvoice(row: Record<string, unknown>): InvoiceView {
    return { id: String(row.id), visit_id: String(row.visit_id), plate: String(row.plate), revision: Number(row.revision),
      parking_minor: Number(row.parking_minor), electricity_minor: Number(row.electricity_minor), total_minor: Number(row.total_minor),
      billing_basis: String(row.billing_basis), status: row.status as InvoiceStatus, created_at: String(row.created_at),
      updated_at: String(row.updated_at), paid_minor: row.paid_minor === null ? null : Number(row.paid_minor) };
  }

  private toFinancialAdjustment(row: Record<string, unknown>): FinancialAdjustmentView {
    return { id: String(row.id), request_id: String(row.request_id), visit_id: String(row.visit_id),
      invoice_id: row.invoice_id === null ? null : String(row.invoice_id), plate: String(row.plate),
      kind: row.kind as FinancialAdjustmentKind, amount_minor: Number(row.amount_minor), reason: String(row.reason),
      actor: String(row.actor), at: String(row.at) };
  }

  private toIncident(row: Record<string, unknown>): IncidentView {
    return {
      id: String(row.id), type: String(row.type), severity: row.severity as IncidentSeverity, status: row.status as IncidentStatus,
      summary: String(row.summary), opened_at: String(row.opened_at), updated_at: String(row.updated_at),
      resolved_at: (row.resolved_at as string | null) ?? null, plate: (row.plate as string | null) ?? null,
      component: (row.component as string | null) ?? null, component_type: (row.component_type as IncidentView["component_type"]) ?? null,
      zone: (row.zone as string | null) ?? null, lane: (row.lane as string | null) ?? null,
      reason: (row.reason as string | null) ?? null, details: JSON.parse(String(row.details)) as Record<string, unknown>,
    };
  }

  searchAudit(limit = 100) {
    const rows = this.db.prepare(`SELECT id, at, actor_username, action, target, reason, details
      FROM audit_log ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 1000))) as {
        id: number; at: string; actor_username: string | null; action: string; target: string | null; reason: string | null; details: string;
      }[];
    return rows.map((r) => ({ ...r, details: JSON.parse(r.details) as Record<string, unknown> }));
  }

  auditRequestResult(action: string, requestId: string): string | null {
    const row = this.db.prepare("SELECT details FROM audit_log WHERE action = ? AND json_extract(details, '$.request_id') = ? ORDER BY id DESC LIMIT 1")
      .get(action, requestId) as { details: string } | undefined;
    if (!row) return null;
    const details = JSON.parse(row.details) as Record<string, unknown>;
    return typeof details.result === "string" ? details.result : "processed";
  }

  /** Latest manual occupancy assertion per spot. This derives live quarantine state from
   * the append-only audit trail so it survives restarts without a second mutable ledger. */
  manualSpotOccupancyStates(): ManualSpotOccupancyState[] {
    const rows = this.db.prepare(`SELECT a.target, a.action, a.at, a.actor_username, a.reason, a.details
      FROM audit_log a
      JOIN (SELECT target, max(id) AS id FROM audit_log
        WHERE action IN ('spot.manual_occupancy.reported', 'spot.manual_occupancy.cleared') AND target IS NOT NULL
        GROUP BY target) latest ON latest.id = a.id
      ORDER BY a.target`).all() as {
        target: string; action: ManualSpotOccupancyAction; at: string; actor_username: string | null;
        reason: string | null; details: string;
      }[];
    return rows.map((row) => {
      const details = JSON.parse(row.details) as Record<string, unknown>;
      return { spot: row.target, occupied: row.action === "spot.manual_occupancy.reported",
        version: Number.isInteger(details.state_version) ? Number(details.state_version) : 0,
        actor: row.actor_username, at: row.at, reason: row.reason,
        observation: typeof details.observation === "string" ? details.observation : null };
    });
  }

  manualSpotOccupancyState(spot: string): ManualSpotOccupancyState {
    return this.manualSpotOccupancyStates().find((state) => state.spot === spot) ?? {
      spot, occupied: false, version: 0, actor: null, at: "", reason: null, observation: null,
    };
  }

  /** A request ID may be retried after a lost HTTP response, but not repurposed for a
   * different spot or for the opposite occupancy transition. */
  manualSpotOccupancyRequest(requestId: string): { spot: string; action: ManualSpotOccupancyAction; result: string } | undefined {
    const row = this.db.prepare(`SELECT target, action, details FROM audit_log
      WHERE action IN ('spot.manual_occupancy.reported', 'spot.manual_occupancy.cleared')
        AND json_extract(details, '$.request_id') = ? ORDER BY id DESC LIMIT 1`).get(requestId) as {
          target: string | null; action: ManualSpotOccupancyAction; details: string;
        } | undefined;
    if (!row?.target) return undefined;
    const details = JSON.parse(row.details) as Record<string, unknown>;
    return { spot: row.target, action: row.action, result: typeof details.result === "string" ? details.result : "processed" };
  }

  recordManualSpotOccupancy(input: {
    actorId: number; actorUsername: string; action: ManualSpotOccupancyAction; spot: string;
    version: number; requestId: string; reason: string; observation: string; result: string;
    sensorEvidence?: { representation: "count"; count: number };
  }): void {
    this.recordAudit({ actorId: input.actorId, actorUsername: input.actorUsername, action: input.action,
      target: input.spot, reason: input.reason, details: { state_version: input.version, request_id: input.requestId,
        observation: input.observation, result: input.result, ...(input.sensorEvidence ? { sensor_evidence: input.sensorEvidence } : {}) } });
  }

  createMaintenanceJob(input: CreateMaintenanceJob): MaintenanceJobView {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO maintenance_jobs
      (id, component_type, component, zone, status, requested_by, assigned_to, reason, requested_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.componentType, input.component, input.zone, input.status ?? "requested", input.requestedBy,
        input.assignedTo ?? null, input.reason.trim(), now, now);
    return this.getMaintenanceJob(id)!;
  }

  getMaintenanceJob(id: string): MaintenanceJobView | undefined {
    const row = this.db.prepare("SELECT * FROM maintenance_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toMaintenanceJob(row) : undefined;
  }

  listMaintenanceJobs(limit = 100, forUsername?: string): MaintenanceJobView[] {
    const rows = forUsername
      ? this.db.prepare("SELECT * FROM maintenance_jobs WHERE assigned_to IS NULL OR assigned_to = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?")
        .all(forUsername, Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM maintenance_jobs ORDER BY requested_at DESC, rowid DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[];
    return rows.map((row) => this.toMaintenanceJob(row));
  }

  /** Claim an unassigned request (or return the caller's existing claim), without a read/write race. */
  assignMaintenanceJob(id: string, username: string): MaintenanceJobView | undefined {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE maintenance_jobs SET assigned_to = ?, updated_at = ?
      WHERE id = ? AND status = 'requested' AND (assigned_to IS NULL OR assigned_to = ?)`).run(username, now, id, username);
    const job = this.getMaintenanceJob(id);
    return job?.assigned_to === username ? job : undefined;
  }

  activeMaintenanceJobs(): MaintenanceJobView[] {
    const rows = this.db.prepare("SELECT * FROM maintenance_jobs WHERE status IN ('requested', 'in_progress') ORDER BY requested_at")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.toMaintenanceJob(row));
  }

  updateMaintenanceJob(id: string, status: MaintenanceStatus, resolution?: string | null): MaintenanceJobView | undefined {
    const now = new Date().toISOString();
    const completedAt = status === "completed" || status === "failed" ? now : null;
    this.db.prepare(`UPDATE maintenance_jobs SET status = ?, updated_at = ?, completed_at = ?, resolution = ? WHERE id = ?`)
      .run(status, now, completedAt, resolution ?? null, id);
    return this.getMaintenanceJob(id);
  }

  activeMaintenanceJob(type: MaintenanceComponentType, component: string): MaintenanceJobView | undefined {
    const row = this.db.prepare(`SELECT * FROM maintenance_jobs WHERE component_type = ? AND component = ?
      AND status IN ('requested', 'in_progress') ORDER BY requested_at DESC LIMIT 1`).get(type, component) as Record<string, unknown> | undefined;
    return row ? this.toMaintenanceJob(row) : undefined;
  }

  finishMaintenanceJob(type: MaintenanceComponentType, component: string, resolution: string): void {
    const job = this.activeMaintenanceJob(type, component);
    if (job) this.updateMaintenanceJob(job.id, "completed", resolution);
  }

  private toMaintenanceJob(row: Record<string, unknown>): MaintenanceJobView {
    return {
      id: String(row.id), component_type: row.component_type as MaintenanceComponentType, component: String(row.component),
      zone: String(row.zone), status: row.status as MaintenanceStatus, requested_by: String(row.requested_by),
      assigned_to: (row.assigned_to as string | null) ?? null,
      reason: String(row.reason), requested_at: String(row.requested_at), updated_at: String(row.updated_at),
      completed_at: (row.completed_at as string | null) ?? null, resolution: (row.resolution as string | null) ?? null,
    };
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
    this.db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_ms, login_attempt_id) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, userId, new Date().toISOString(), expiresMs, null);
  }

  setAuthSessionLoginAttempt(tokenHash: string, attemptId: number): void {
    this.db.prepare("UPDATE auth_sessions SET login_attempt_id = ? WHERE token_hash = ?").run(attemptId, tokenHash);
  }

  sessionLoginAttemptId(tokenHash: string, nowMs: number): number | null {
    const row = this.db.prepare("SELECT login_attempt_id FROM auth_sessions WHERE token_hash = ? AND expires_ms > ?")
      .get(tokenHash, nowMs) as { login_attempt_id: number | null } | undefined;
    return row?.login_attempt_id ?? null;
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
