import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { NormalizedEvent } from '../domain/types.js';
import { verifySignature } from '../simulator/signature.js';
import { AuditService } from './audit.js';

type Ordering = 'in-order' | 'duplicate' | 'gap' | 'out-of-order' | 'reset';
const value = (payload: Record<string, unknown>, ...keys: string[]) => keys.map((key) => payload[key]).find((item) => item !== undefined && item !== null);

export class EventService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database, audit?: AuditService, private readonly clock = () => Date.now()) {
    this.audit = audit || new AuditService(db, clock);
  }

  ingest(payload: Record<string, unknown>): { accepted: boolean; ordering: Ordering; event?: NormalizedEvent; reason?: string } {
    const signature = value(payload, 'Signature', 'signature');
    const eventId = String(value(payload, 'EventId', 'eventId') || randomUUID());
    if (!verifySignature(payload, signature ? String(signature) : undefined)) {
      this.audit.record('webhook-rejected', 'event', eventId, { reason: 'invalid-signature', payload });
      return { accepted: false, ordering: 'out-of-order', reason: 'invalid-signature' };
    }
    if (this.db.get('SELECT event_id FROM events WHERE event_id = :id', { ':id': eventId })) return { accepted: true, ordering: 'duplicate' };
    const sequenceId = Number(value(payload, 'SequenceId', 'sequenceId') || 0);
    const type = String(value(payload, 'Type', 'type') || 'unknown');
    const runId = value(payload, 'RunId', 'runId');
    const receivedAt = new Date(this.clock()).toISOString();
    const previous = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'last_sequence' });
    const previousSequence = previous ? Number(previous.value) : 0;
    const ordering: Ordering = sequenceId === 0 || previousSequence === 0 || sequenceId === previousSequence + 1 ? 'in-order' : sequenceId > previousSequence + 1 ? 'gap' : sequenceId < previousSequence ? 'out-of-order' : 'reset';
    this.db.run('INSERT INTO events (event_id, type, sequence_id, run_id, received_at, signature_valid, raw_json) VALUES (:id, :type, :sequence, :run, :received, 1, :raw)', { ':id': eventId, ':type': type, ':sequence': sequenceId, ':run': runId ? String(runId) : null, ':received': receivedAt, ':raw': JSON.stringify(payload) });
    if (ordering === 'in-order' || ordering === 'gap') this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'last_sequence', ':value': String(sequenceId) });
    this.audit.record('webhook-accepted', 'event', eventId, { type, sequenceId, ordering });
    return { accepted: true, ordering, event: { eventId, type, sequenceId, runId: runId ? String(runId) : undefined, receivedAt, payload } };
  }

  list(limit = 100) { return this.db.all('SELECT * FROM events ORDER BY sequence_id DESC LIMIT :limit', { ':limit': limit }); }
}
