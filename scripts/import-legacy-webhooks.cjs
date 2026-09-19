const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('../src/env.cjs');

loadEnvFile();

const { loadConfig } = require('../src/config.cjs');
const { ParkingDatabase } = require('../src/database.cjs');
const { EventService } = require('../src/event-service.cjs');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'logs', 'webhooks.jsonl');
if (!fs.existsSync(source)) {
  console.log('No legacy webhook log found; nothing to import.');
  process.exit(0);
}

const config = loadConfig(process.env, root);
const database = new ParkingDatabase(config.databasePath);
const events = new EventService(database, {
  requireWebhookSignature: config.requireWebhookSignature,
});
let imported = 0;
let duplicates = 0;
let skipped = 0;

for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const record = JSON.parse(line);
    const payload = record.payload || record;
    const result = events.process(payload);
    if (result.duplicate) duplicates += 1;
    else if (result.accepted) imported += 1;
    else skipped += 1;
  } catch {
    skipped += 1;
  }
}

database.close();
console.log(`Legacy webhook import: ${imported} imported, ${duplicates} duplicates, ${skipped} skipped.`);
