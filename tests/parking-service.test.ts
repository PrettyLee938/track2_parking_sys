import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { FixtureGateway } from '../src/simulator/fixture-gateway.js';
import { AuditService } from '../src/services/audit.js';
import { CommandService } from '../src/services/command-service.js';
import { ParkingService } from '../src/services/parking-service.js';

describe('parking arrival controller', () => {
  it('persists a snapshot and creates a legal entry session', async () => {
    const db = new Database(':memory:');
    const gateway = new FixtureGateway({ runId: 'run-1' });
    await gateway.login();
    const commands = new CommandService(db, gateway, new AuditService(db));
    const parking = new ParkingService(db, commands, new AuditService(db));
    await parking.refreshSnapshot({ runId: 'run-1', levelId: 'lvl1', components: [], zones: [], spots: [{ id: 'E-1', type: 'electric', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }] });
    const session = await parking.createArrival({ plate: 'ABC-123', type: 'electric', accessible: false, needsCharging: true });
    expect(session.spotId).toBe('E-1');
    expect(session.status).toBe('entry-pending');
    expect((db.get<{ reserved: number }>('SELECT reserved FROM spots WHERE id = :id', { ':id': 'E-1' }))?.reserved).toBe(0);
    expect(gateway.commands[0]?.kind).toBe('car.goto');
    parking.applyEvent('car_spot_action', { EventClass: 'car_spot_action', CarPlateNumber: 'ABC-123', SpotName: 'E-1', SpotType: 'Park', Direction: 'CarIn' });
    expect((parking.getSession(session.id) as { status: string }).status).toBe('parked');
    expect((db.get<{ reserved: number }>('SELECT reserved FROM spots WHERE id = :id', { ':id': 'E-1' }))?.reserved).toBe(0);
  });
});
