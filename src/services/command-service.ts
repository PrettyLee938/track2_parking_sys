import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { CommandStatus, SimulatorCommand } from '../domain/types.js';
import type { SimulatorGateway } from '../simulator/contracts.js';
import { AuditService } from './audit.js';

export class CommandService {
  constructor(private readonly db: Database, private readonly gateway: SimulatorGateway, private readonly audit = new AuditService(db), private readonly clock = () => Date.now()) {}

  async issue(input: Omit<SimulatorCommand, 'id'>, actorId?: string) {
    const run = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_status' })?.value;
    if (run !== 'active') throw new Error('run-not-active');
    const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value || null;
    const health = this.gateway.health();
    if (!health.connected || !health.discoveryComplete) throw new Error('gateway-not-connected');
    if (!runId || runId.startsWith('pending-new-') || !health.runId) throw new Error('run-identity-unknown');
    if (health.runId !== runId) throw new Error('run-identity-mismatch');
    const sourceEventId = typeof input.payload.sourceEventId === 'string' ? input.payload.sourceEventId : undefined;
    const existing = sourceEventId && this.db.get<{ id: string; status: CommandStatus; external_status: string | null; external_id: string | null; error: string | null }>('SELECT id, status, external_status, external_id, error FROM commands WHERE source_event_id = :source AND kind = :kind AND run_id = :run', { ':source': sourceEventId, ':kind': input.kind, ':run': runId });
    if (existing) return { ...input, id: existing.id, status: existing.status, acceptance: { accepted: existing.external_status === 'accepted', outcome: existing.status === 'rejected' ? 'rejected' as const : existing.status === 'unknown' ? 'unknown' as const : 'accepted' as const, externalId: existing.external_id || undefined, error: existing.error || undefined } };
    const command: SimulatorCommand = { ...input, id: randomUUID() };
    const now = new Date(this.clock()).toISOString();
    this.db.run('INSERT INTO commands (id, kind, target, payload_json, status, created_at, updated_at, run_id, external_id, source_event_id) VALUES (:id, :kind, :target, :payload, :status, :created, :updated, :run, :external, :source)', { ':id': command.id, ':kind': command.kind, ':target': command.target, ':payload': JSON.stringify(command.payload), ':status': 'pending', ':created': now, ':updated': now, ':run': runId, ':external': null, ':source': sourceEventId || null });
    let acceptance;
    try { acceptance = await this.gateway.send(command); }
    catch (error) { acceptance = { accepted: false, outcome: 'unknown' as const, externalId: undefined, error: error instanceof Error ? error.message : String(error) }; }
    const status: CommandStatus = acceptance.outcome === 'accepted' ? 'pending' : acceptance.outcome === 'rejected' ? 'rejected' : 'unknown';
    if (status === 'unknown') this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'reconciling' });
    this.db.transaction(() => {
      this.db.run('UPDATE commands SET status = :status, external_status = :external, external_id = :externalId, error = :error, updated_at = :updated WHERE id = :id', { ':status': status, ':external': acceptance.accepted ? 'accepted' : 'failed', ':externalId': acceptance.externalId || null, ':error': acceptance.error || null, ':updated': new Date(this.clock()).toISOString(), ':id': command.id });
      this.audit.record('command-issued', 'command', command.id, { ...command, acceptance }, actorId);
    });
    return { ...command, status, acceptance };
  }

  list(limit = 100) { return this.db.all('SELECT * FROM commands ORDER BY created_at DESC LIMIT :limit', { ':limit': limit }); }

  markConfirmed(id: string, actorId?: string) {
    const command = this.db.get<{ id: string }>('SELECT id FROM commands WHERE (id = :id OR external_id = :id) AND status IN (:pending, :unknown)', { ':id': id, ':pending': 'pending', ':unknown': 'unknown' });
    if (!command) return;
    this.db.transaction(() => {
      this.db.run('UPDATE commands SET status = :status, updated_at = :updated WHERE id = :id AND status IN (:pending, :unknown)', { ':status': 'confirmed', ':updated': new Date(this.clock()).toISOString(), ':id': command.id, ':pending': 'pending', ':unknown': 'unknown' });
      this.audit.record('command-confirmed', 'command', command.id, { evidenceId: id }, actorId);
    });
  }

  confirmFromEvent(payload: Record<string, unknown>) {
    const id = payload.CommandId || payload.commandId || payload.CorrelationId || payload.correlationId;
    if (id) this.markConfirmed(String(id));
  }

  cancel(id: string, actorId?: string) {
    this.db.run('UPDATE commands SET status = :status, updated_at = :updated WHERE id = :id AND status IN (:pending, :unknown)', { ':status': 'cancelled', ':updated': new Date(this.clock()).toISOString(), ':id': id, ':pending': 'pending', ':unknown': 'unknown' });
    this.audit.record('command-cancelled', 'command', id, {}, actorId);
  }
}
