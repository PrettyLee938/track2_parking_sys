import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schema } from './schema.js';

type Bindings = Record<string, unknown> | unknown[];

export class Database {
  private readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec(schema);
    const columns = this.connection.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'signature_digest')) this.connection.exec('ALTER TABLE events ADD COLUMN signature_digest TEXT');
    this.connection.exec('PRAGMA foreign_keys = ON');
  }

  run(sql: string, bindings: Bindings = {}) {
    return this.connection.prepare(sql).run(bindings as never);
  }

  get<T>(sql: string, bindings: Bindings = {}): T | undefined {
    return this.connection.prepare(sql).get(bindings as never) as T | undefined;
  }

  all<T>(sql: string, bindings: Bindings = {}): T[] {
    return this.connection.prepare(sql).all(bindings as never) as T[];
  }

  transaction<T>(work: () => T): T {
    this.connection.exec('BEGIN');
    try {
      const result = work();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.connection.close();
  }
}
