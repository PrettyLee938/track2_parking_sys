// Clears penalty records this application stored. It does NOT clear the
// simulator's own score: those fines belong to the simulator and are only reset
// by reloading the level.
//
//   node scripts/reset-penalties.cjs            show what is stored
//   node scripts/reset-penalties.cjs --delete   delete stored penalty events
//   node scripts/reset-penalties.cjs --all      delete every event and command
//
// Stop the API first, or SQLite may report "database is locked".
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const file = path.resolve(__dirname, '..', 'data', 'parking.db');
if (!fs.existsSync(file)) {
  console.log(`No database at ${file}; nothing to reset.`);
  process.exit(0);
}

const mode = process.argv.includes('--all') ? 'all'
  : process.argv.includes('--delete') ? 'penalties'
    : 'report';
const db = new DatabaseSync(file);

const total = db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_class = 'penalty'").get().n;
const reasons = db.prepare(`
  SELECT json_extract(payload_json, '$.Reason') AS reason, COUNT(*) AS n
  FROM events WHERE event_class = 'penalty' GROUP BY reason ORDER BY n DESC
`).all();

console.log(`Stored penalty events: ${total}`);
for (const row of reasons) console.log(`  ${String(row.reason).slice(0, 52).padEnd(54)}${row.n}`);

if (mode === 'report') {
  console.log('\nNothing deleted. Re-run with --delete (penalties) or --all (full history).');
} else if (mode === 'penalties') {
  const result = db.prepare("DELETE FROM events WHERE event_class = 'penalty'").run();
  console.log(`\nDeleted ${result.changes} penalty events.`);
} else {
  const events = db.prepare('DELETE FROM events').run();
  const commands = db.prepare('DELETE FROM commands').run();
  const cars = db.prepare('DELETE FROM cars').run();
  db.prepare("DELETE FROM metadata WHERE key = 'last_sequence_id'").run();
  console.log(`\nDeleted ${events.changes} events, ${commands.changes} commands, ${cars.changes} cars.`);
}

db.close();
console.log('\nThe simulator keeps its own score. Reload the level there to reset it.');
