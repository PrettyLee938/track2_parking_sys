import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';

describe('database foundation', () => {
  it('creates the durable schema in memory', () => {
    const db = new Database(':memory:');
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(['users', 'events', 'commands', 'audit', 'parking_sessions']));
    db.close();
  });
});
