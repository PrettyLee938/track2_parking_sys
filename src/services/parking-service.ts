import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { chooseSpot } from '../domain/allocation.js';
import type { CarType, SimulatorSnapshot, SpotCandidate } from '../domain/types.js';
import { AuditService } from './audit.js';
import type { CommandService } from './command-service.js';

export interface ArrivalInput { plate: string; type: CarType; accessible: boolean; needsCharging: boolean; }

const bool = (value: unknown) => Boolean(Number(value));
const flag = (value: unknown) => value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1';
const spotFromRow = (row: Record<string, unknown>): SpotCandidate => ({
  id: String(row.id), type: row.type as SpotCandidate['type'], accessible: bool(row.accessible), occupied: bool(row.occupied), reserved: bool(row.reserved), broken: bool(row.broken), underMaintenance: bool(row.under_maintenance), reachable: bool(row.reachable), zoneSafe: bool(row.zone_safe), rank: Number(row.rank)
});

export class ParkingService {
  constructor(private readonly db: Database, private readonly commands: CommandService, private readonly audit = new AuditService(db), private readonly clock = () => Date.now(), private readonly entryGateName = 'gateA') {}

  async refreshSnapshot(snapshot: SimulatorSnapshot) {
    this.db.transaction(() => {
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_id', ':value': snapshot.runId });
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'level_id', ':value': snapshot.levelId });
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'active' });
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'topology', ':value': JSON.stringify(snapshot.topology || []) });
      for (const spot of snapshot.spots) {
        this.db.run('INSERT INTO spots (id, type, accessible, occupied, reserved, broken, under_maintenance, reachable, zone_safe, rank, run_id) VALUES (:id, :type, :accessible, :occupied, :reserved, :broken, :maintenance, :reachable, :safe, :rank, :run) ON CONFLICT(id) DO UPDATE SET type=excluded.type, accessible=excluded.accessible, occupied=excluded.occupied, broken=excluded.broken, under_maintenance=excluded.under_maintenance, reachable=excluded.reachable, zone_safe=excluded.zone_safe, rank=excluded.rank, run_id=excluded.run_id', { ':id': spot.id, ':type': spot.type, ':accessible': +spot.accessible, ':occupied': +spot.occupied, ':reserved': +spot.reserved, ':broken': +spot.broken, ':maintenance': +spot.underMaintenance, ':reachable': +spot.reachable, ':safe': +spot.zoneSafe, ':rank': spot.rank, ':run': snapshot.runId });
        this.db.run('INSERT INTO components (id, kind, zone_id, status, updated_at) VALUES (:id, :kind, :zone, :status, :updated) ON CONFLICT(id) DO UPDATE SET zone_id=excluded.zone_id, status=excluded.status, updated_at=excluded.updated_at', { ':id': spot.id, ':kind': 'parking-spot', ':zone': spot.zoneId || null, ':status': spot.broken ? 'broken' : spot.underMaintenance ? 'under-maintenance' : 'healthy', ':updated': new Date(this.clock()).toISOString() });
      }
      const devices = [...(snapshot.components || []), ...(snapshot.barriers || []), ...(snapshot.lights || []), ...(snapshot.fans || []), ...(snapshot.alarms || [])];
      for (const device of devices) {
        const id = String(device.id || device.Id || device.name || device.Name || randomUUID());
        this.db.run('INSERT INTO components (id, kind, zone_id, status, usage_count, updated_at) VALUES (:id, :kind, :zone, :status, :usage, :updated) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, zone_id=excluded.zone_id, status=excluded.status, usage_count=excluded.usage_count, updated_at=excluded.updated_at', { ':id': id, ':kind': String(device.kind || device.Kind || device.type || device.Type || 'component'), ':zone': device.zoneId || device.ZoneParent || null, ':status': String(device.status || device.Status || 'healthy'), ':usage': Number(device.usageCount || device.UsageCounter || 0), ':updated': new Date(this.clock()).toISOString() });
      }
      for (const zone of snapshot.zones || []) {
        const id = String(zone.id || zone.Id || zone.name || zone.Name || randomUUID());
        this.db.run('INSERT INTO components (id, kind, zone_id, status, updated_at) VALUES (:id, :kind, :zone, :status, :updated) ON CONFLICT(id) DO UPDATE SET zone_id=excluded.zone_id, status=excluded.status, updated_at=excluded.updated_at', { ':id': `zone:${id}`, ':kind': 'zone', ':zone': id, ':status': 'observed', ':updated': new Date(this.clock()).toISOString() });
      }
    });
  }

  private async reserveArrival(input: ArrivalInput, actorId?: string) {
    const currentRun = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' });
    const rows = this.db.all<Record<string, unknown>>('SELECT * FROM spots WHERE run_id = :run', { ':run': currentRun?.value || '' });
    const choice = chooseSpot({ carType: input.type, accessible: input.accessible, needsCharging: input.needsCharging, spots: rows.map(spotFromRow) });
    if (!choice.spotId) { this.audit.record('arrival-rejected', 'car', input.plate, { reason: choice.reason }); throw new Error(choice.reason); }
    const sessionId = randomUUID();
    const now = new Date(this.clock()).toISOString();
    try {
      this.db.transaction(() => {
        this.db.run('INSERT INTO cars (plate, type, accessible, created_at) VALUES (:plate, :type, :accessible, :created) ON CONFLICT(plate) DO UPDATE SET type=excluded.type, accessible=excluded.accessible', { ':plate': input.plate, ':type': input.type, ':accessible': +input.accessible, ':created': now });
        const assigned = this.db.get('SELECT id FROM parking_sessions WHERE spot_id = :spot AND run_id = (SELECT value FROM meta WHERE key = :runKey) AND status IN (\'entry-pending\', \'parked\')', { ':spot': choice.spotId, ':runKey': 'run_id' });
        if (assigned) throw new Error('spot-unavailable');
        this.db.run('INSERT INTO parking_sessions (id, plate, status, spot_id, needs_charging, started_at, run_id) VALUES (:id, :plate, :status, :spot, :charging, :started, (SELECT value FROM meta WHERE key = :run))', { ':id': sessionId, ':plate': input.plate, ':status': 'entry-pending', ':spot': choice.spotId, ':charging': +input.needsCharging, ':started': now, ':run': 'run_id' });
        this.db.run('UPDATE spots SET reserved = 1 WHERE id = :spot', { ':spot': choice.spotId });
      });
    } catch (error) { this.audit.record('arrival-rejected', 'car', input.plate, { reason: error instanceof Error ? error.message : String(error) }, actorId); throw error; }
    return { id: sessionId, plate: input.plate, spotId: choice.spotId, status: 'entry-pending' as const };
  }

  private async dispatchEntry(session: { id: string; plate: string; spotId: string }, actorId?: string, sourceEventId = session.id) {
    let command;
    try { command = await this.commands.issue({ kind: 'car.goto', target: `/api/v1/car/${encodeURIComponent(session.plate)}/goto/${encodeURIComponent(session.spotId)}`, payload: { plate: session.plate, destination: session.spotId, sessionId: session.id, sourceEventId } }, actorId); }
    catch (error) {
      this.db.transaction(() => { this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'entry-rejected', ':id': session.id }); this.db.run('UPDATE spots SET reserved = 0 WHERE id = :spot', { ':spot': session.spotId }); this.audit.record('arrival-rejected', 'parking-session', session.id, { reason: error instanceof Error ? error.message : String(error) }, actorId); });
      throw error;
    }
    if (command.status === 'rejected') {
      this.db.transaction(() => { this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'entry-rejected', ':id': session.id }); this.db.run('UPDATE spots SET reserved = 0 WHERE id = :spot', { ':spot': session.spotId }); this.audit.record('arrival-rejected', 'parking-session', session.id, { reason: 'simulator-command-rejected', commandId: command.id }, actorId); });
      throw new Error('entry-command-rejected');
    }
    this.audit.record(command.status === 'unknown' ? 'arrival-command-unknown' : 'arrival-allocated', 'parking-session', session.id, { plate: session.plate, spotId: session.spotId, commandId: command.id }, actorId);
    return { ...session, status: 'entry-pending' as const, commandId: command.id };
  }

  async createArrival(input: ArrivalInput, actorId?: string) {
    const session = await this.reserveArrival(input, actorId);
    return this.dispatchEntry(session, actorId);
  }

  private carInput(payload: Record<string, unknown>): ArrivalInput | undefined {
    const plate = String(payload.CarPlateNumber || payload.carPlateNumber || payload.CarName || payload.carName || payload.Plate || payload.plate || '').trim();
    if (!plate) return undefined;
    const rawType = String(payload.CarType || payload.carType || 'Normal').toLowerCase();
    const type = rawType.includes('electric') ? 'electric' : 'normal';
    const accessible = flag(payload.Accessible ?? payload.accessible) || rawType.includes('accessible');
    return { plate, type, accessible, needsCharging: type === 'electric' };
  }

  private gateIsOpen() {
    const gate = this.db.get<{ status: string }>('SELECT status FROM components WHERE id = :id AND kind = :kind', { ':id': this.entryGateName, ':kind': 'barrier-gate' });
    return gate?.status.toLowerCase() === 'open';
  }

  private async requestEntryGate() {
    const gate = this.db.get<{ status: string }>('SELECT status FROM components WHERE id = :id AND kind = :kind', { ':id': this.entryGateName, ':kind': 'barrier-gate' });
    if (!gate) throw new Error('entry-gate-not-found');
    const state = gate.status.toLowerCase();
    if (state === 'broken' || state === 'under-maintenance' || state === 'repair-requested') throw new Error('entry-gate-unavailable');
    if (state === 'open' || state === 'opening') return;
    const target = `/api/v1/barrier-gates/${encodeURIComponent(this.entryGateName)}/open`;
    if (this.db.get('SELECT id FROM commands WHERE kind = :kind AND target = :target AND status IN (\'pending\', \'unknown\') LIMIT 1', { ':kind': 'gate.open', ':target': target })) return;
    await this.commands.issue({ kind: 'gate.open', target, payload: { id: this.entryGateName } });
    this.audit.record('entry-gate-requested', 'component', this.entryGateName, {});
  }

  private async dispatchPendingEntries() {
    if (!this.gateIsOpen()) return;
    const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value || '';
    const pending = this.db.all<{ id: string; plate: string; spot_id: string }>('SELECT id, plate, spot_id FROM parking_sessions WHERE run_id = :run AND status = :status ORDER BY started_at', { ':run': runId, ':status': 'entry-pending' });
    for (const session of pending) {
      const existing = this.db.get('SELECT id FROM commands WHERE run_id = :run AND kind = :kind AND source_event_id = :source LIMIT 1', { ':run': runId, ':kind': 'car.goto', ':source': session.id });
      if (!existing) await this.dispatchEntry({ id: session.id, plate: session.plate, spotId: session.spot_id }, undefined, session.id);
    }
  }

  async handleEntryEvent(payload: Record<string, unknown>, eventId?: string) {
    const spotType = String(payload.SpotType || payload.spotType || '').toLowerCase();
    const direction = String(payload.Direction || payload.direction || '').toLowerCase();
    if (spotType !== 'entryspot' || direction !== 'carin') return;
    const input = this.carInput(payload);
    if (!input) return;
    const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value || '';
    const existing = this.db.get('SELECT id FROM parking_sessions WHERE plate = :plate AND run_id = :run AND status IN (\'entry-pending\', \'parked\', \'at-exit\', \'departure-pending\') LIMIT 1', { ':plate': input.plate, ':run': runId });
    if (!existing) {
      try { await this.reserveArrival(input); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === 'no-legal-candidate' || reason === 'spot-unavailable') return;
        throw error;
      }
    }
    await this.requestEntryGate();
    await this.dispatchPendingEntries();
  }

  async handleGateEvent(payload: Record<string, unknown>) {
    const name = String(payload.Name || payload.name || '').trim();
    const action = String(payload.Action || payload.action || '').toLowerCase();
    if (name === this.entryGateName && action === 'open') await this.dispatchPendingEntries();
  }

  listSessions(limit = 100) { return this.db.all('SELECT * FROM parking_sessions ORDER BY started_at DESC LIMIT :limit', { ':limit': limit }); }
  getSession(id: string) { return this.db.get('SELECT * FROM parking_sessions WHERE id = :id', { ':id': id }); }

  markAtExit(id: string) {
    this.db.transaction(() => {
      const session = this.db.get<{ spot_id: string | null; status: string }>('SELECT spot_id, status FROM parking_sessions WHERE id = :id', { ':id': id });
      if (!session || session.status === 'departure-pending' || session.status === 'departed') return;
      this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'at-exit', ':id': id });
      if (session.spot_id) this.db.run('UPDATE spots SET occupied = 0, reserved = 0 WHERE id = :id', { ':id': session.spot_id });
      this.audit.record('exit-arrived', 'parking-session', id, { spotId: session.spot_id });
    });
  }

  applyEvent(type: string, payload: Record<string, unknown>) {
    if (type !== 'car_spot_action') return;
    const plate = String(payload.CarPlateNumber || payload.carPlateNumber || payload.CarName || payload.carName || payload.Plate || payload.plate || '');
    const spot = String(payload.SpotName || payload.spotName || payload.Destination || payload.destination || '');
    const spotType = String(payload.SpotType || payload.spotType || '').toLowerCase();
    const direction = String(payload.Direction || payload.direction || '').toLowerCase();
    if (!plate) return;
    const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
    const session = this.db.get<{ id: string; spot_id: string | null }>('SELECT id, spot_id FROM parking_sessions WHERE plate = :plate AND run_id = :run ORDER BY started_at DESC LIMIT 1', { ':plate': plate, ':run': runId || '' });
    if (!session) return;
    const legacyExit = !spotType && !direction && spot.toLowerCase().includes('exit');
    const legacyPark = !spotType && !direction;
    if ((spotType === 'exitspot' && direction === 'carin') || legacyExit) {
      const current = this.db.get<{ status: string }>('SELECT status FROM parking_sessions WHERE id = :id', { ':id': session.id });
      if (current?.status !== 'departure-pending') this.markAtExit(session.id);
    }
    else if ((spotType === 'park' && direction === 'carin') || legacyPark) {
      this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'parked', ':id': session.id });
      if (session.spot_id) this.db.run('UPDATE spots SET occupied = 1, reserved = 0 WHERE id = :id', { ':id': session.spot_id });
    }
    else if (spotType === 'park' && direction === 'carout' && session.spot_id) {
      this.db.run('UPDATE spots SET occupied = 0 WHERE id = :id', { ':id': session.spot_id });
    }
  }
}
