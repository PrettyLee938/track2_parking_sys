import { randomUUID } from 'node:crypto';
import type { AuthService, User } from '../auth/service.js';
import type { Database } from '../db/database.js';
import type { InvoiceInput } from '../domain/types.js';
import { calculateInvoice } from '../domain/billing.js';
import { AuditService } from './audit.js';
import type { CommandService } from './command-service.js';

function toCents(value: unknown) {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return Number.NaN;
  const fraction = `${match[3] || ''}00`.slice(0, 2);
  const cents = Number(match[2]) * 100 + Number(fraction);
  return match[1] === '-' ? -cents : cents;
}

export class PaymentService {
  constructor(private readonly db: Database, private readonly commands: CommandService, private readonly auth: AuthService, private readonly audit = new AuditService(db), private readonly clock = () => Date.now()) {}

  private currentSession(sessionId: string, allowReconciling = false) {
    const session = this.db.get<{ id: string; plate: string; status: string; run_id: string | null }>('SELECT id, plate, status, run_id FROM parking_sessions WHERE id = :id', { ':id': sessionId });
    const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
    const runStatus = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_status' })?.value;
    if (!session || session.run_id !== runId || (!allowReconciling && runStatus !== 'active')) throw new Error('session-not-current-run');
    return session;
  }

  async createInvoice(sessionId: string, input: InvoiceInput) {
    this.currentSession(sessionId);
    const total = calculateInvoice(input);
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.run('INSERT INTO invoices (id, session_id, parking_cents, electricity_cents, total_cents, status, created_at) VALUES (:id, :session, :parking, :electricity, :total, :status, :created)', { ':id': id, ':session': sessionId, ':parking': total.parkingCents, ':electricity': total.electricityCents, ':total': total.totalCents, ':status': 'open', ':created': new Date(this.clock()).toISOString() });
      this.audit.record('invoice-created', 'invoice', id, { sessionId, ...total });
    });
    return { id, sessionId, ...total, status: 'open' as const };
  }

  async recordPayment(sessionId: string, amountCents: number, paymentId: string = randomUUID(), allowReconciling = false) {
    const session = this.currentSession(sessionId, allowReconciling);
    if (session.status !== 'at-exit' && session.status !== 'departure-pending') throw new Error('car-not-at-exit');
    const notification = this.db.get<{ session_id: string }>('SELECT session_id FROM payment_notifications WHERE id = :id', { ':id': paymentId });
    if (notification && notification.session_id !== sessionId) throw new Error('payment-id-session-mismatch');
    const existing = this.db.get<{ status: 'valid' | 'invalid'; reason: string | null }>('SELECT v.status, v.reason FROM payment_validations v JOIN payment_notifications n ON n.id = v.notification_id WHERE v.notification_id = :id AND n.session_id = :session ORDER BY v.validated_at DESC LIMIT 1', { ':id': paymentId, ':session': sessionId });
    if (existing) return { id: paymentId, status: existing.status, reason: existing.reason || undefined };
    const invoice = this.db.get<{ id: string; total_cents: number }>('SELECT id, total_cents FROM invoices WHERE session_id = :session ORDER BY created_at DESC LIMIT 1', { ':session': sessionId });
    if (!invoice) throw new Error('invoice-missing');
    const duplicate = this.db.get('SELECT id FROM payments WHERE session_id = :session AND status = :status', { ':session': sessionId, ':status': 'valid' });
    const status = duplicate ? 'invalid' : amountCents === invoice.total_cents ? 'valid' : 'invalid';
    const reason = duplicate ? 'duplicate-payment' : status === 'valid' ? undefined : 'amount-mismatch';
    const receivedAt = new Date(this.clock()).toISOString();
    this.db.transaction(() => {
      this.db.run('INSERT OR IGNORE INTO payment_notifications (id, session_id, amount_cents, received_at, raw_json) VALUES (:id, :session, :amount, :received, :raw)', { ':id': paymentId, ':session': sessionId, ':amount': amountCents, ':received': receivedAt, ':raw': JSON.stringify({ paymentId, sessionId, amountCents }) });
      this.db.run('INSERT INTO payment_validations (id, notification_id, status, reason, validated_at) VALUES (:id, :notification, :status, :reason, :validated)', { ':id': randomUUID(), ':notification': paymentId, ':status': status, ':reason': reason || null, ':validated': receivedAt });
      this.db.run('INSERT OR IGNORE INTO payments (id, session_id, amount_cents, status, received_at) VALUES (:id, :session, :amount, :status, :received)', { ':id': paymentId, ':session': sessionId, ':amount': amountCents, ':status': status, ':received': receivedAt });
      if (status === 'valid') this.db.run('UPDATE overrides SET status = :invalidated WHERE session_id = :session AND status = :active', { ':invalidated': 'invalidated', ':session': sessionId, ':active': 'active' });
      this.audit.record('payment-recorded', 'payment', paymentId, { sessionId, amountCents, status, reason });
    });
    return { id: paymentId, status: status as 'valid' | 'invalid', reason };
  }

  async authorizeUnpaid(sessionId: string, actor: User, password: string, reason: string) {
    if (actor.role !== 'admin') throw new Error('forbidden');
    await this.auth.reauthenticate(actor, password);
    const session = this.currentSession(sessionId);
    if (!session || session.status !== 'at-exit') throw new Error('car-not-at-exit');
    if (!this.db.get('SELECT id FROM invoices WHERE session_id = :session', { ':session': sessionId })) throw new Error('invoice-missing');
    if (this.db.get('SELECT id FROM payments WHERE session_id = :session AND status = :status', { ':session': sessionId, ':status': 'valid' })) throw new Error('payment-already-valid');
    if (!reason.trim()) throw new Error('reason-required');
    const id = randomUUID();
    try {
      this.db.transaction(() => {
        if (this.db.get('SELECT id FROM overrides WHERE session_id = :session AND status = :status', { ':session': sessionId, ':status': 'active' })) throw new Error('override-already-active');
        this.db.run('INSERT INTO overrides (id, session_id, admin_user_id, reason, status, created_at) VALUES (:id, :session, :admin, :reason, :status, :created)', { ':id': id, ':session': sessionId, ':admin': actor.id, ':reason': reason.trim(), ':status': 'active', ':created': new Date(this.clock()).toISOString() });
        this.audit.record('unpaid-release-authorized', 'override', id, { sessionId, reason: reason.trim() }, actor.id);
      });
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('override-already-active');
      throw error;
    }
    return { id, sessionId, status: 'active' as const };
  }

  async requestDeparture(sessionId: string, actorId?: string) {
    const session = this.currentSession(sessionId);
    if (!session || session.status !== 'at-exit') throw new Error('car-not-at-exit');
    const paid = this.db.get('SELECT id FROM payments WHERE session_id = :session AND status = :status', { ':session': sessionId, ':status': 'valid' });
    const override = this.db.get('SELECT id FROM overrides WHERE session_id = :session AND status = :status', { ':session': sessionId, ':status': 'active' });
    if (!paid && !override) throw new Error('payment-required');
    const command = await this.commands.issue({ kind: 'car.depart', target: `/api/v1/car/${encodeURIComponent(session.plate)}/goto/exit`, payload: { plate: session.plate, destination: 'exit', sessionId } }, actorId);
    if (command.status === 'rejected') throw new Error('departure-command-rejected');
    this.db.transaction(() => {
      this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'departure-pending', ':id': sessionId });
      this.audit.record('departure-requested', 'parking-session', sessionId, { commandId: command.id }, actorId);
    });
    return { sessionId, status: 'departure-pending' as const, commandId: command.id };
  }

  async confirmDeparture(sessionId: string, allowReconciling = false) {
    this.currentSession(sessionId, allowReconciling);
    const endedAt = new Date(this.clock()).toISOString();
    this.db.transaction(() => {
      const session = this.db.get<{ spot_id: string | null }>('SELECT spot_id FROM parking_sessions WHERE id = :id', { ':id': sessionId });
      this.db.run('UPDATE parking_sessions SET status = :status, ended_at = :ended WHERE id = :id', { ':status': 'departed', ':ended': endedAt, ':id': sessionId });
      if (session?.spot_id) this.db.run('UPDATE spots SET occupied = 0, reserved = 0 WHERE id = :id', { ':id': session.spot_id });
      this.db.run('UPDATE overrides SET status = :status, consumed_at = :consumed WHERE session_id = :session AND status = :active', { ':status': 'consumed', ':consumed': endedAt, ':session': sessionId, ':active': 'active' });
      this.audit.record('departure-confirmed', 'parking-session', sessionId, {});
    });
  }

  async applyEvent(type: string, payload: Record<string, unknown>) {
    if (type === 'payment_made') {
      const plate = String(payload.CarPlateNumber || payload.carPlateNumber || payload.Plate || payload.plate || '');
      const explicitSessionId = String(payload.SessionId || payload.sessionId || '');
      const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
      const sessionId = explicitSessionId || (plate ? this.db.get<{ id: string }>('SELECT id FROM parking_sessions WHERE plate = :plate AND run_id = :run AND status IN (\'at-exit\', \'departure-pending\') ORDER BY started_at DESC LIMIT 1', { ':plate': plate, ':run': runId || '' })?.id || '' : '');
      const amount = payload.AmountCents !== undefined || payload.amountCents !== undefined
        ? Number(payload.AmountCents ?? payload.amountCents)
        : toCents(payload.Amount ?? payload.amount);
      const paymentId = String(payload.EventId || payload.eventId || randomUUID());
      if (sessionId && Number.isFinite(amount)) {
        try { await this.recordPayment(sessionId, amount, paymentId, true); }
        catch (error) {
          const receivedAt = new Date(this.clock()).toISOString();
          this.db.transaction(() => {
            this.db.run('INSERT OR IGNORE INTO payment_notifications (id, session_id, amount_cents, received_at, raw_json) VALUES (:id, :session, :amount, :received, :raw)', { ':id': paymentId, ':session': sessionId, ':amount': amount, ':received': receivedAt, ':raw': JSON.stringify(payload) });
            this.db.run('INSERT INTO payment_validations (id, notification_id, status, reason, validated_at) VALUES (:id, :notification, :status, :reason, :validated)', { ':id': randomUUID(), ':notification': paymentId, ':status': 'invalid', ':reason': error instanceof Error ? error.message : String(error), ':validated': receivedAt });
            this.audit.record('payment-rejected', 'payment-notification', paymentId, { sessionId, amount, reason: error instanceof Error ? error.message : String(error) });
          });
        }
      }
    }
    if (type === 'car_spot_action') {
      const plate = String(payload.CarPlateNumber || payload.carPlateNumber || payload.CarName || payload.carName || payload.Plate || payload.plate || '');
      const destination = String(payload.SpotName || payload.spotName || payload.Destination || payload.destination || '').toLowerCase();
      const spotType = String(payload.SpotType || payload.spotType || '').toLowerCase();
      const direction = String(payload.Direction || payload.direction || '').toLowerCase();
      const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
      const session = this.db.get<{ id: string; status: string }>('SELECT id, status FROM parking_sessions WHERE plate = :plate AND run_id = :run ORDER BY started_at DESC LIMIT 1', { ':plate': plate, ':run': runId || '' });
      if (session?.status === 'departure-pending' && (spotType === 'exitspot' && direction === 'carout' || !spotType && !direction && destination.includes('exit'))) await this.confirmDeparture(session.id, true);
    }
  }
}
