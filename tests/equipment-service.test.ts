import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { FixtureGateway } from '../src/simulator/fixture-gateway.js';
import { AuditService } from '../src/services/audit.js';
import { CommandService } from '../src/services/command-service.js';
import { EquipmentService } from '../src/services/equipment-service.js';

describe('equipment and environment controller', () => {
  it('keeps repair pending until a fixed event arrives', async () => {
    const db = new Database(':memory:');
    const gateway = new FixtureGateway();
    await gateway.login();
    const audit = new AuditService(db);
    const service = new EquipmentService(db, new CommandService(db, gateway, audit), audit);
    db.run("INSERT INTO meta (key, value) VALUES ('run_id', 'run-1'), ('run_status', 'active')");
    await service.applyEvent({ type: 'component_broken', payload: { ComponentId: 'fan-1', ComponentType: 'fan' } });
    expect((service.list()[0] as { status: string }).status).toBe('broken');
    const repair = await service.requestRepair('fan-1');
    expect(repair.status).toBe('repair-requested');
    await service.applyEvent({ type: 'component_fixed', payload: { ComponentId: 'fan-1' } });
    expect((service.list()[0] as { status: string }).status).toBe('healthy');
  });

  it('does not allow a fan to be disabled while CO is high', async () => {
    const db = new Database(':memory:');
    const gateway = new FixtureGateway(); await gateway.login();
    const audit = new AuditService(db);
    const service = new EquipmentService(db, new CommandService(db, gateway, audit), audit, () => Date.now(), 50);
    db.run("INSERT INTO meta (key, value) VALUES ('run_id', 'run-1'), ('run_status', 'active')");
    await service.applyEvent({ type: 'carbon_monoxide_event', payload: { ZoneId: 'z1', CoLevel: 80 } });
    await expect(service.setFan('fan-1', false)).rejects.toThrow('fan-required-for-co');
  });
});
