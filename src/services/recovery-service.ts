import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { SimulatorGateway } from '../simulator/contracts.js';
import { AuditService } from './audit.js';
import type { ParkingService } from './parking-service.js';
import type { SimulatorSnapshot } from '../domain/types.js';

export class RecoveryService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;
  private pendingSnapshot: SimulatorSnapshot | undefined;

  constructor(private readonly db: Database, private readonly gateway: SimulatorGateway, private readonly parking: ParkingService, private readonly audit = new AuditService(db)) {}

  startAutomaticResume(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.meta('run_status') === 'reconciling' && !this.reconciling) {
        this.reconciling = true;
        void this.reconcile().finally(() => { this.reconciling = false; });
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stopAutomaticResume() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  beginStartupReconciliation() {
    const status = this.meta('run_status');
    if (!status || status === 'active' || status === 'reconciling') this.setMeta('run_status', 'reconciling');
  }

  private meta(key: string) { return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': key })?.value; }
  private setMeta(key: string, value: string) { this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': key, ':value': value }); }

  async reconcile() {
    this.setMeta('run_status', 'reconciling');
    try {
      const snapshot = await this.gateway.reconcile();
      const current = this.meta('run_id');
      if (current && current !== snapshot.runId) {
        this.setMeta('run_status', 'ambiguous');
        this.setMeta('pending_run_id', snapshot.runId);
        this.pendingSnapshot = snapshot;
        this.audit.record('run-ambiguous', 'simulator-run', snapshot.runId, { previousRunId: current, observedRunId: snapshot.runId });
        return { status: 'ambiguous' as const, runId: snapshot.runId };
      }
      await this.parking.refreshSnapshot(snapshot);
      if (!current) this.setMeta('run_id', snapshot.runId);
      this.setMeta('run_status', 'active');
      this.audit.record('run-reconciled', 'simulator-run', snapshot.runId, {});
      return { status: 'resumed' as const, runId: snapshot.runId };
    } catch (error) {
      this.setMeta('run_status', 'reconciling');
      this.audit.record('run-reconcile-failed', 'simulator-run', this.meta('run_id'), { error: error instanceof Error ? error.message : String(error) });
      return { status: 'unknown' as const, runId: this.meta('run_id') };
    }
  }

  closeRun(actorId: string) {
    const runId = this.meta('run_id');
    this.db.transaction(() => { this.setMeta('run_status', 'closed'); this.audit.record('run-closed', 'simulator-run', runId, {}, actorId); });
    return { status: 'closed' as const, runId };
  }

  startNewRun(actorId: string) {
    const previous = this.meta('run_id');
    const runId = `pending-new-${randomUUID()}`;
    this.db.transaction(() => {
      this.db.run('DELETE FROM spots');
      this.db.run('DELETE FROM components');
      if (previous) {
        this.db.run("UPDATE commands SET status = 'unknown' WHERE run_id = :run AND status IN ('pending', 'unknown')", { ':run': previous });
        this.db.run("UPDATE overrides SET status = 'closed' WHERE session_id IN (SELECT id FROM parking_sessions WHERE run_id = :run) AND status = 'active'", { ':run': previous });
      }
      this.setMeta('run_id', runId);
      this.setMeta('run_status', 'reconciling');
      this.setMeta('last_sequence', '0');
      this.setMeta('pending_run_id', '');
      this.audit.record('run-started', 'simulator-run', runId, { previousRunId: previous }, actorId);
    });
    return { status: 'active' as const, runId };
  }

  async continueRun(actorId: string) {
    if (this.meta('run_status') !== 'ambiguous') throw new Error('run-not-ambiguous');
    const runId = this.meta('pending_run_id') || this.meta('run_id');
    const snapshot = await this.gateway.reconcile();
    if (snapshot.runId !== runId) { this.setMeta('pending_run_id', snapshot.runId); throw new Error('run-changed'); }
    await this.parking.refreshSnapshot(snapshot);
    this.pendingSnapshot = undefined;
    this.db.transaction(() => {
      this.setMeta('run_id', runId || 'unknown');
      this.setMeta('pending_run_id', '');
      this.setMeta('last_sequence', '0');
      this.setMeta('run_status', 'active');
      this.audit.record('run-continued', 'simulator-run', runId, {}, actorId);
    });
    return { status: 'active' as const, runId };
  }

  status() { return { runId: this.meta('run_id'), status: this.meta('run_status') || 'unknown' }; }

  correctAudit(actorId: string, originalId: number, details: Record<string, unknown>) {
    this.audit.record('audit-correction', 'audit', String(originalId), details, actorId, originalId);
  }
}
