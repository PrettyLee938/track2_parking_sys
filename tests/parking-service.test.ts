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
    expect((db.get<{ reserved: number }>('SELECT reserved FROM spots WHERE id = :id', { ':id': 'E-1' }))?.reserved).toBe(1);
    expect(gateway.commands[0]?.kind).toBe('car.goto');
    parking.applyEvent('car_spot_action', { EventClass: 'car_spot_action', CarPlateNumber: 'ABC-123', SpotName: 'E-1', SpotType: 'Park', Direction: 'CarIn' });
    expect((parking.getSession(session.id) as { status: string }).status).toBe('parked');
    expect((db.get<{ reserved: number }>('SELECT reserved FROM spots WHERE id = :id', { ':id': 'E-1' }))?.reserved).toBe(0);
  });

  it('opens the entry gate before dispatching a simulator car', async () => {
    const db = new Database(':memory:');
    const gateway = new FixtureGateway({ runId: 'run-1', components: [{ id: 'gateA', kind: 'barrier-gate', status: 'Closed' }] });
    await gateway.login();
    const audit = new AuditService(db);
    const parking = new ParkingService(db, new CommandService(db, gateway, audit), audit);
    await parking.refreshSnapshot({ runId: 'run-1', levelId: 'lvl1', components: [{ id: 'gateA', kind: 'barrier-gate', status: 'Closed' }], zones: [], spots: [{ id: 'S-1', type: 'any', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }] });
    await parking.handleEntryEvent({ CarPlateNumber: 'X-1', CarType: 'Normal', SpotType: 'EntrySpot', Direction: 'CarIn' });
    expect(gateway.commands.map((command) => command.kind)).toEqual(['gate.open']);
    db.run("UPDATE components SET status = 'open' WHERE id = 'gateA'");
    await parking.handleGateEvent({ Name: 'gateA', Action: 'Open' });
    expect(gateway.commands.map((command) => command.kind)).toEqual(['gate.open', 'car.goto']);
    expect((gateway.commands[1]?.payload as { destination: string }).destination).toBe('S-1');
  });

  it('releases the parking bay when the car reaches the exit spot', async () => {
    const db = new Database(':memory:');
    const gateway = new FixtureGateway({ runId: 'run-1' });
    await gateway.login();
    const audit = new AuditService(db);
    const parking = new ParkingService(db, new CommandService(db, gateway, audit), audit);
    await parking.refreshSnapshot({ runId: 'run-1', levelId: 'lvl1', components: [], zones: [], spots: [{ id: 'S-1', type: 'any', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }, { id: 'S-2', type: 'any', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 2 }] });
    const session = await parking.createArrival({ plate: 'X-2', type: 'normal', accessible: false, needsCharging: false });
    parking.applyEvent('car_spot_action', { CarPlateNumber: 'X-2', SpotName: 'S-1', SpotType: 'Park', Direction: 'CarIn' });
    parking.applyEvent('car_spot_action', { CarPlateNumber: 'X-2', SpotName: 'EXIT_EXIT', SpotType: 'ExitSpot', Direction: 'CarIn' });
    expect((parking.getSession(session.id) as { status: string }).status).toBe('at-exit');
    expect((db.get<{ occupied: number; reserved: number }>('SELECT occupied, reserved FROM spots WHERE id = :id', { ':id': 'S-1' }))).toEqual({ occupied: 0, reserved: 0 });
    expect((await parking.createArrival({ plate: 'X-3', type: 'normal', accessible: false, needsCharging: false })).spotId).toBe('S-1');
  });

  it('records a full-park arrival without blocking later webhook processing', async () => {
    const db = new Database(':memory:');
    const gateway = new FixtureGateway({ runId: 'run-1' });
    await gateway.login();
    const audit = new AuditService(db);
    const parking = new ParkingService(db, new CommandService(db, gateway, audit), audit);
    await parking.refreshSnapshot({ runId: 'run-1', levelId: 'lvl1', components: [], zones: [], spots: [{ id: 'S-1', type: 'any', accessible: false, occupied: true, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }] });
    await expect(parking.handleEntryEvent({ CarPlateNumber: 'FULL-1', CarType: 'Normal', SpotType: 'EntrySpot', Direction: 'CarIn' })).resolves.toBeUndefined();
    expect((audit.list() as Array<{ action: string }>).some((entry) => entry.action === 'arrival-rejected')).toBe(true);
  });
});
