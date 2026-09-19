import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { Database } from '../src/db/database.js';
import { FixtureGateway } from '../src/simulator/fixture-gateway.js';
import { AuditService } from '../src/services/audit.js';
import { CommandService } from '../src/services/command-service.js';
import { ParkingService } from '../src/services/parking-service.js';
import { PaymentService } from '../src/services/payment-service.js';

async function fixture() {
  const db = new Database(':memory:');
  const gateway = new FixtureGateway({ runId: 'run-1' });
  await gateway.login();
  const audit = new AuditService(db);
  const commands = new CommandService(db, gateway, audit);
  const parking = new ParkingService(db, commands, audit);
  const auth = new AuthService(db, 30_000);
  await auth.seedAdmin('admin', 'secret');
  const admin = await auth.login('admin', 'secret');
  await parking.refreshSnapshot({ runId: 'run-1', levelId: 'lvl1', components: [], zones: [], spots: [{ id: 'N-1', type: 'any', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }] });
  const session = await parking.createArrival({ plate: 'ABC-123', type: 'normal', accessible: false, needsCharging: false });
  parking.markAtExit(session.id);
  return { db, auth, admin, commands, parking, payments: new PaymentService(db, commands, auth, audit) , session };
}

describe('billing and departure', () => {
  it('validates payment before issuing departure', async () => {
    const { payments, session, commands } = await fixture();
    await payments.createInvoice(session.id, { durationMinutes: 60, parkingRateCentsPerHour: 100, electricityKwh: 0, electricityRateCentsPerKwh: 40 });
    expect((await payments.recordPayment(session.id, 99)).status).toBe('invalid');
    expect((await payments.recordPayment(session.id, 100)).status).toBe('valid');
    const departure = await payments.requestDeparture(session.id);
    expect(departure.status).toBe('departure-pending');
    expect((commands.list()[0] as { kind: string }).kind).toBe('car.depart');
    expect((commands.list()[0] as { target: string }).target).toContain('/goto/leavepark');
    expect(JSON.parse((commands.list()[0] as { payload_json: string }).payload_json).sourceEventId).toBe(session.id);
  });

  it('requires Admin re-authentication for an unpaid-release authorization', async () => {
    const { payments, session, admin } = await fixture();
    await payments.createInvoice(session.id, { durationMinutes: 60, parkingRateCentsPerHour: 100, electricityKwh: 0, electricityRateCentsPerKwh: 40 });
    await expect(payments.authorizeUnpaid(session.id, admin.user, 'wrong', 'business exception')).rejects.toThrow('invalid-credentials');
    const override = await payments.authorizeUnpaid(session.id, admin.user, 'secret', 'business exception');
    expect(override.status).toBe('active');
    expect((await payments.requestDeparture(session.id)).status).toBe('departure-pending');
  });

  it('maps a simulator payment webhook by plate and decimal amount', async () => {
    const { payments, session, db } = await fixture();
    await payments.createInvoice(session.id, { durationMinutes: 60, parkingRateCentsPerHour: 100, electricityKwh: 0, electricityRateCentsPerKwh: 40 });
    await payments.applyEvent('payment_made', { EventClass: 'payment_made', CarPlateNumber: 'ABC-123', Amount: '1.00', EventId: 'payment-1' });
    expect((db.get<{ status: string }>('SELECT status FROM payments WHERE id = :id', { ':id': 'payment-1' }))?.status).toBe('valid');
    expect((db.get<{ status: string }>('SELECT status FROM invoices WHERE session_id = :id', { ':id': session.id }))?.status).toBe('paid');
  });

  it('creates the simulator charge command once and uses simulator cost units', async () => {
    const { payments, session, commands, db } = await fixture();
    const charge = await payments.requestCharge(session.id, 1.25, 0.5);
    expect(charge.invoice.totalCents).toBe(175);
    expect((commands.list()[0] as { kind: string }).kind).toBe('car.charge');
    expect((commands.list()[0] as { target: string }).target).toContain('parkingCost=1.25');
    expect((await payments.requestCharge(session.id, 1.25, 0.5)).commandId).toBe(charge.commandId);
    expect(db.all('SELECT id FROM invoices WHERE session_id = :id', { ':id': session.id })).toHaveLength(1);
  });
});
