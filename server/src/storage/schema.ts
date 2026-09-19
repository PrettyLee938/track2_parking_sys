import type Database from "better-sqlite3";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, event_id TEXT, seq INTEGER, event_class TEXT NOT NULL,
  plate TEXT, spot TEXT, received_at TEXT NOT NULL, received_ms INTEGER NOT NULL,
  sig TEXT, accepted INTEGER NOT NULL, duplicate INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_received ON events (received_ms);
CREATE INDEX IF NOT EXISTS events_plate ON events (plate, received_ms);
CREATE INDEX IF NOT EXISTS events_class ON events (event_class, received_ms);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, plate TEXT NOT NULL, car_type TEXT, status TEXT NOT NULL,
  entry_lane TEXT, exit_lane TEXT, spot TEXT, planned_minutes INTEGER,
  arrived_at TEXT, parked_at TEXT, left_spot_at TEXT, exit_at TEXT, left_at TEXT,
  parked_seconds REAL, charge_parking REAL, charge_electric REAL, charge_attempts INTEGER,
  paid REAL, payment_ok INTEGER, recorded_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_plate ON sessions (plate, recorded_at);
CREATE INDEX IF NOT EXISTS sessions_recorded ON sessions (recorded_at);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, cmd TEXT NOT NULL, args TEXT NOT NULL,
  ok INTEGER NOT NULL, error TEXT, ms REAL
);
CREATE INDEX IF NOT EXISTS actions_at ON actions (at);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_ms INTEGER NOT NULL
);
`;

export function migrate(db: Database.Database): void {
  const columns = (table: string) => new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
  );
  const events = columns("events");
  if (!events.has("spot_type")) {
    db.exec(`ALTER TABLE events ADD COLUMN spot_type TEXT; ALTER TABLE events ADD COLUMN direction TEXT;
      UPDATE events SET spot_type = json_extract(payload, '$.SpotType'), direction = json_extract(payload, '$.Direction');`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS events_flow ON events (spot_type, direction, received_ms)");
  if (!columns("actions").has("actor")) db.exec("ALTER TABLE actions ADD COLUMN actor TEXT");
}
