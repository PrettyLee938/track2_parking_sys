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
});
