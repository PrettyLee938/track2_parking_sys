import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { FixtureGateway } from '../src/simulator/fixture-gateway.js';
import { AuditService } from '../src/services/audit.js';
import { CommandService } from '../src/services/command-service.js';
import { ParkingService } from '../src/services/parking-service.js';
import { RecoveryService } from '../src/services/recovery-service.js';

describe('run recovery', () => {
  it('pauses on a changed simulator run and isolates a new run', async () => {
    const db = new Database(':memory:');
    const audit = new AuditService(db);
    const first = new FixtureGateway({ runId: 'run-1' });
    await first.login();
    const parking = new ParkingService(db, new CommandService(db, first, audit), audit);
    await parking.refreshSnapshot({ runId: 'run-1', levelId: 'lvl1', components: [], zones: [], spots: [] });
    const second = new FixtureGateway({ runId: 'run-2' });
    await second.login();
    const recovery = new RecoveryService(db, second, parking, audit);
    expect((await recovery.reconcile()).status).toBe('ambiguous');
    await recovery.closeRun('admin-1');
    const next = await recovery.startNewRun('admin-1');
    expect(next.status).toBe('active');
    expect(next.runId).not.toBe('run-1');
  });

  it('adopts a legacy local identity when no operational state exists', async () => {
    const db = new Database(':memory:');
    const audit = new AuditService(db);
    const first = new FixtureGateway({ runId: 'local-legacy' });
    await first.login();
    const parking = new ParkingService(db, new CommandService(db, first, audit), audit);
    await parking.refreshSnapshot({ runId: 'local-legacy', levelId: 'lvl1', components: [], zones: [], spots: [] });
    db.run("UPDATE meta SET value = 'ambiguous' WHERE key = 'run_status'");
    db.run("INSERT INTO meta (key, value) VALUES ('pending_run_id', 'local-current')");
    const second = new FixtureGateway({ runId: 'local-current' });
    await second.login();
    const recovery = new RecoveryService(db, second, parking, audit);
    recovery.beginStartupReconciliation();
    expect((await recovery.reconcile()).status).toBe('resumed');
    expect(recovery.status()).toMatchObject({ runId: 'local-current', status: 'active' });
  });

  it('baselines a missed webhook sequence when no work exists to reconcile', async () => {
    const db = new Database(':memory:');
    const audit = new AuditService(db);
    const gateway = new FixtureGateway({ runId: 'local-run' });
    await gateway.login();
    const parking = new ParkingService(db, new CommandService(db, gateway, audit), audit);
    db.run("INSERT INTO meta (key, value) VALUES ('run_id', 'local-run'), ('run_status', 'reconciling'), ('reconcile_reason', 'sequence-gap'), ('last_sequence', '3')");
    for (const sequenceId of [5, 6]) {
      db.run('INSERT INTO events (event_id, type, sequence_id, run_id, received_at, signature_valid, signature_digest, raw_json) VALUES (:id, :type, :sequence, :run, :received, 0, :digest, :raw)', { ':id': `gap-${sequenceId}`, ':type': 'car_spot_action', ':sequence': sequenceId, ':run': 'local-run', ':received': new Date().toISOString(), ':digest': '', ':raw': '{}' });
    }
    const recovery = new RecoveryService(db, gateway, parking, audit);
    expect((await recovery.reconcile()).status).toBe('resumed');
    expect(recovery.status()).toMatchObject({ runId: 'local-run', status: 'active' });
    expect(db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'reconcile_reason' })).toBeUndefined();
    expect(db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'last_sequence' })?.value).toBe('6');
    expect(db.get<{ processed: number }>('SELECT processed FROM events WHERE event_id = :id', { ':id': 'gap-6' })?.processed).toBe(1);
  });
});
