export const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
  password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, type TEXT NOT NULL, sequence_id INTEGER NOT NULL,
  run_id TEXT, received_at TEXT NOT NULL, signature_valid INTEGER NOT NULL,
  signature_digest TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_sequence_idx ON events(sequence_id);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL, external_status TEXT, external_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT, run_id TEXT
);
CREATE TABLE IF NOT EXISTS cars (
  plate TEXT PRIMARY KEY, type TEXT NOT NULL, accessible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parking_sessions (
  id TEXT PRIMARY KEY, plate TEXT NOT NULL, status TEXT NOT NULL,
  spot_id TEXT, needs_charging INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT, run_id TEXT
);
CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, accessible INTEGER NOT NULL,
  occupied INTEGER NOT NULL, reserved INTEGER NOT NULL, broken INTEGER NOT NULL,
  under_maintenance INTEGER NOT NULL, reachable INTEGER NOT NULL,
  zone_safe INTEGER NOT NULL, rank INTEGER NOT NULL, run_id TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parking_cents INTEGER NOT NULL,
  electricity_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_notifications (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  received_at TEXT NOT NULL, raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_validations (
  id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, status TEXT NOT NULL,
  reason TEXT, validated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overrides (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS active_override_idx ON overrides(session_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, zone_id TEXT,
  status TEXT NOT NULL, usage_count INTEGER NOT NULL DEFAULT 0,
  co_level REAL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT, details_json TEXT NOT NULL,
  created_at TEXT NOT NULL, corrects_id INTEGER
);
`;
