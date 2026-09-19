import type { Database } from '../db/database.js';
import type { NormalizedEvent } from '../domain/types.js';
import { AuditService } from './audit.js';
import { WebhookBoundary } from '../simulator/webhook-boundary.js';

type Ordering = 'in-order' | 'duplicate' | 'gap' | 'out-of-order' | 'reset';
export interface IngestResult { accepted: boolean; ordering: Ordering; event?: NormalizedEvent; readyEvents?: NormalizedEvent[]; reason?: string; }
export class EventService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database, audit?: AuditService, private readonly clock = () => Date.now(), private readonly boundary: WebhookBoundary = new WebhookBoundary()) {
    this.audit = audit || new AuditService(db, clock);
  }

  ingest(payload: Record<string, unknown>): IngestResult {
    const envelope = this.boundary.accept(payload);
    const eventId = envelope.eventId;
    if (!envelope.valid) { const reason = envelope.reason || 'invalid-signature'; this.audit.record('webhook-rejected', 'event', eventId, { reason, calculatedDigest: envelope.calculatedDigest, signatureMode: envelope.signatureMode, payload }); return { accepted: false, ordering: 'out-of-order', reason }; }
    const existing = this.db.get<{ event_id: string; type: string; sequence_id: number; run_id: string | null; received_at: string; raw_json: string; processed: number }>('SELECT event_id, type, sequence_id, run_id, received_at, raw_json, processed FROM events WHERE event_id = :id', { ':id': eventId });
    if (existing) {
      if (existing.processed) return { accepted: true, ordering: 'duplicate' };
      const active = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_status' })?.value === 'active';
      return active ? { accepted: true, ordering: 'duplicate', readyEvents: this.pendingEvents(existing.run_id || undefined) } : { accepted: true, ordering: 'duplicate' };
    }
    const sequenceId = envelope.sequenceId;
    const type = envelope.type;
    const runText = envelope.runId;
    const receivedAt = new Date(this.clock()).toISOString();
    const previous = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'last_sequence' });
    const previousRun = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
    const previousSequence = previous ? Number(previous.value) : 0;
    const sequenceReset = sequenceId > 0 && previousSequence > 0 && sequenceId < previousSequence;
    const ordering: Ordering = runText && previousRun && runText !== previousRun ? 'reset' : sequenceReset ? 'reset' : sequenceId === 0 && previousSequence > 0 ? 'out-of-order' : sequenceId === 0 || previousSequence === 0 || sequenceId === previousSequence + 1 ? 'in-order' : sequenceId > previousSequence + 1 ? 'gap' : 'out-of-order';
    const event = { eventId, type, sequenceId, runId: runText, receivedAt, payload };
    this.db.transaction(() => {
      this.db.run('INSERT INTO events (event_id, type, sequence_id, run_id, received_at, signature_valid, signature_digest, raw_json) VALUES (:id, :type, :sequence, :run, :received, :signatureValid, :digest, :raw)', { ':id': eventId, ':type': type, ':sequence': sequenceId, ':run': runText || null, ':received': receivedAt, ':signatureValid': envelope.signatureMode === 'verified' ? 1 : 0, ':digest': envelope.calculatedDigest, ':raw': JSON.stringify(payload) });
      if (ordering === 'in-order') {
        this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'last_sequence', ':value': String(sequenceId) });
        if (runText && !previousRun) this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_id', ':value': runText });
      }
      if (ordering === 'reset') {
        this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'pending_run_id', ':value': runText || '' });
        this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'ambiguous' });
      }
      if (ordering === 'gap' || ordering === 'out-of-order') {
        this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'reconciling' });
        this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'reconcile_reason', ':value': 'sequence-gap' });
      }
      this.audit.record('webhook-accepted', 'event', eventId, { type, sequenceId, ordering, signatureMode: envelope.signatureMode });
    });
    if (ordering !== 'in-order') return { accepted: true, ordering, event };
    const readyEvents = this.collectReady(event);
    if (event.sequenceId > 0 && this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'reconcile_reason' })?.value === 'sequence-gap') {
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'active' });
      this.db.run('DELETE FROM meta WHERE key = :key', { ':key': 'reconcile_reason' });
    }
    return { accepted: true, ordering, event, readyEvents };
  }

  private collectReady(current: NormalizedEvent) {
    if (current.sequenceId <= 0) return [current];
    const rows = this.db.all<{ event_id: string; type: string; sequence_id: number; run_id: string | null; received_at: string; raw_json: string }>('SELECT event_id, type, sequence_id, run_id, received_at, raw_json FROM events WHERE processed = 0 AND sequence_id > :sequence AND ((run_id = :run) OR (:run IS NULL AND run_id IS NULL)) ORDER BY sequence_id', { ':sequence': current.sequenceId, ':run': current.runId || null });
    const ready = [current];
    let cursor = current.sequenceId;
    for (const row of rows) {
      if (row.sequence_id !== cursor + 1) break;
      ready.push({ eventId: row.event_id, type: row.type, sequenceId: row.sequence_id, runId: row.run_id || undefined, receivedAt: row.received_at, payload: JSON.parse(row.raw_json) as Record<string, unknown> });
      cursor = row.sequence_id;
    }
    if (cursor !== current.sequenceId) this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'last_sequence', ':value': String(cursor) });
    return ready;
  }

  private pendingEvents(runId?: string) {
    const rows = this.db.all<{ event_id: string; type: string; sequence_id: number; run_id: string | null; received_at: string; raw_json: string }>('SELECT event_id, type, sequence_id, run_id, received_at, raw_json FROM events WHERE processed = 0 AND ((run_id = :run) OR (:run IS NULL AND run_id IS NULL)) ORDER BY sequence_id', { ':run': runId || null });
    const last = this.db.get<{ sequence_id: number }>('SELECT MAX(sequence_id) AS sequence_id FROM events WHERE processed = 1 AND ((run_id = :run) OR (:run IS NULL AND run_id IS NULL))', { ':run': runId || null })?.sequence_id;
    let expected = last === undefined || last === null ? rows[0]?.sequence_id || 0 : last + 1;
    const ready = [];
    for (const row of rows) {
      if (row.sequence_id > 0 && row.sequence_id !== expected) break;
      ready.push({ eventId: row.event_id, type: row.type, sequenceId: row.sequence_id, runId: row.run_id || undefined, receivedAt: row.received_at, payload: JSON.parse(row.raw_json) as Record<string, unknown> });
      if (row.sequence_id > 0) expected = row.sequence_id + 1;
    }
    return ready;
  }

  pending(runId?: string) { return this.pendingEvents(runId); }

  markProcessed(eventId: string) { this.db.run('UPDATE events SET processed = 1 WHERE event_id = :id', { ':id': eventId }); }

  list(limit = 100) { return this.db.all('SELECT * FROM events ORDER BY sequence_id DESC LIMIT :limit', { ':limit': limit }); }
}
