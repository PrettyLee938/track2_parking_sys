import type { Database } from '../db/database.js';
import type { NormalizedEvent } from '../domain/types.js';
import { AuditService } from './audit.js';
import { WebhookBoundary } from '../simulator/webhook-boundary.js';

type Ordering = 'in-order' | 'duplicate' | 'gap' | 'out-of-order' | 'reset';
export class EventService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database, audit?: AuditService, private readonly clock = () => Date.now(), private readonly boundary: WebhookBoundary = new WebhookBoundary()) {
    this.audit = audit || new AuditService(db, clock);
  }

  ingest(payload: Record<string, unknown>): { accepted: boolean; ordering: Ordering; event?: NormalizedEvent; reason?: string } {
    const envelope = this.boundary.accept(payload);
    const eventId = envelope.eventId;
    if (!envelope.valid) { const reason = envelope.reason || 'invalid-signature'; this.audit.record('webhook-rejected', 'event', eventId, { reason, payload }); return { accepted: false, ordering: 'out-of-order', reason }; }
    if (this.db.get('SELECT event_id FROM events WHERE event_id = :id', { ':id': eventId })) return { accepted: true, ordering: 'duplicate' };
    const sequenceId = envelope.sequenceId;
    const type = envelope.type;
    const runText = envelope.runId;
    const receivedAt = new Date(this.clock()).toISOString();
    const previous = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'last_sequence' });
    const previousRun = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
    const previousSequence = previous ? Number(previous.value) : 0;
    const ordering: Ordering = runText && previousRun && runText !== previousRun ? 'reset' : sequenceId === 0 || previousSequence === 0 || sequenceId === previousSequence + 1 ? 'in-order' : sequenceId > previousSequence + 1 ? 'gap' : 'out-of-order';
    this.db.run('INSERT INTO events (event_id, type, sequence_id, run_id, received_at, signature_valid, raw_json) VALUES (:id, :type, :sequence, :run, :received, 1, :raw)', { ':id': eventId, ':type': type, ':sequence': sequenceId, ':run': runText || null, ':received': receivedAt, ':raw': JSON.stringify(payload) });
    if (ordering === 'in-order') {
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'last_sequence', ':value': String(sequenceId) });
      if (runText && !previousRun) this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_id', ':value': runText });
    }
    if (ordering === 'reset') {
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'pending_run_id', ':value': runText || '' });
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'ambiguous' });
    }
    this.audit.record('webhook-accepted', 'event', eventId, { type, sequenceId, ordering });
    return { accepted: true, ordering, event: { eventId, type, sequenceId, runId: runText, receivedAt, payload } };
  }

  list(limit = 100) { return this.db.all('SELECT * FROM events ORDER BY sequence_id DESC LIMIT :limit', { ':limit': limit }); }
}
