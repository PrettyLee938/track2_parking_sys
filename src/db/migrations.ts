import type { DatabaseSync } from 'node:sqlite';

type Migration = { version: number; apply: (connection: DatabaseSync) => void };

const migrations: Migration[] = [{
  version: 1,
  apply(connection) {
    const columns = connection.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'signature_digest')) connection.exec('ALTER TABLE events ADD COLUMN signature_digest TEXT');
    if (!columns.some((column) => column.name === 'processed')) connection.exec('ALTER TABLE events ADD COLUMN processed INTEGER NOT NULL DEFAULT 0');
    const commandColumns = connection.prepare('PRAGMA table_info(commands)').all() as Array<{ name: string }>;
    if (!commandColumns.some((column) => column.name === 'external_id')) connection.exec('ALTER TABLE commands ADD COLUMN external_id TEXT');
  }
}];

export function runMigrations(connection: DatabaseSync) {
  connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(connection.prepare('SELECT version FROM schema_migrations').all().map((row) => Number((row as { version: number }).version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    connection.exec('BEGIN');
    try {
      migration.apply(connection);
      connection.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
}
