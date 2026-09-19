import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { chooseSpot } from '../domain/allocation.js';
import type { CarType, SimulatorSnapshot, SpotCandidate } from '../domain/types.js';
import { AuditService } from './audit.js';
import type { CommandService } from './command-service.js';

export interface ArrivalInput { plate: string; type: CarType; accessible: boolean; needsCharging: boolean; }

const bool = (value: unknown) => Boolean(Number(value));
const spotFromRow = (row: Record<string, unknown>): SpotCandidate => ({
  id: String(row.id), type: row.type as SpotCandidate['type'], accessible: bool(row.accessible), occupied: bool(row.occupied), reserved: bool(row.reserved), broken: bool(row.broken), underMaintenance: bool(row.under_maintenance), reachable: bool(row.reachable), zoneSafe: bool(row.zone_safe), rank: Number(row.rank)
});

export class ParkingService {
  constructor(private readonly db: Database, private readonly commands: CommandService, private readonly audit = new AuditService(db), private readonly clock = () => Date.now()) {}

  async refreshSnapshot(snapshot: SimulatorSnapshot) {
    this.db.transaction(() => {
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_id', ':value': snapshot.runId });
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'run_status', ':value': 'active' });
      this.db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': 'topology', ':value': JSON.stringify(snapshot.topology || []) });
      for (const spot of snapshot.spots) this.db.run('INSERT INTO spots (id, type, accessible, occupied, reserved, broken, under_maintenance, reachable, zone_safe, rank, run_id) VALUES (:id, :type, :accessible, :occupied, :reserved, :broken, :maintenance, :reachable, :safe, :rank, :run) ON CONFLICT(id) DO UPDATE SET type=excluded.type, accessible=excluded.accessible, occupied=excluded.occupied, broken=excluded.broken, under_maintenance=excluded.under_maintenance, reachable=excluded.reachable, zone_safe=excluded.zone_safe, rank=excluded.rank, run_id=excluded.run_id', { ':id': spot.id, ':type': spot.type, ':accessible': +spot.accessible, ':occupied': +spot.occupied, ':reserved': +spot.reserved, ':broken': +spot.broken, ':maintenance': +spot.underMaintenance, ':reachable': +spot.reachable, ':safe': +spot.zoneSafe, ':rank': spot.rank, ':run': snapshot.runId });
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

  async createArrival(input: ArrivalInput, actorId?: string) {
    const currentRun = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' });
    const rows = this.db.all<Record<string, unknown>>('SELECT * FROM spots WHERE run_id = :run', { ':run': currentRun?.value || '' });
    const choice = chooseSpot({ carType: input.type, accessible: input.accessible, needsCharging: input.needsCharging, spots: rows.map(spotFromRow) });
    if (!choice.spotId) throw new Error(choice.reason);
    const sessionId = randomUUID();
    const now = new Date(this.clock()).toISOString();
    this.db.transaction(() => {
      this.db.run('INSERT INTO cars (plate, type, accessible, created_at) VALUES (:plate, :type, :accessible, :created) ON CONFLICT(plate) DO UPDATE SET type=excluded.type, accessible=excluded.accessible', { ':plate': input.plate, ':type': input.type, ':accessible': +input.accessible, ':created': now });
      const assigned = this.db.get('SELECT id FROM parking_sessions WHERE spot_id = :spot AND status IN (\'entry-pending\', \'parked\', \'at-exit\', \'departure-pending\')', { ':spot': choice.spotId });
      if (assigned) throw new Error('spot-unavailable');
      this.db.run('INSERT INTO parking_sessions (id, plate, status, spot_id, needs_charging, started_at, run_id) VALUES (:id, :plate, :status, :spot, :charging, :started, (SELECT value FROM meta WHERE key = :run))', { ':id': sessionId, ':plate': input.plate, ':status': 'entry-pending', ':spot': choice.spotId, ':charging': +input.needsCharging, ':started': now, ':run': 'run_id' });
    });
    const command = await this.commands.issue({ kind: 'car.goto', target: `/api/v1/car/${encodeURIComponent(input.plate)}/goto/${encodeURIComponent(choice.spotId)}`, payload: { plate: input.plate, destination: choice.spotId } }, actorId);
    this.audit.record('arrival-allocated', 'parking-session', sessionId, { plate: input.plate, spotId: choice.spotId, commandId: command.id }, actorId);
    return { id: sessionId, plate: input.plate, spotId: choice.spotId, status: 'entry-pending' as const, commandId: command.id };
  }

  listSessions(limit = 100) { return this.db.all('SELECT * FROM parking_sessions ORDER BY started_at DESC LIMIT :limit', { ':limit': limit }); }
  getSession(id: string) { return this.db.get('SELECT * FROM parking_sessions WHERE id = :id', { ':id': id }); }

  markAtExit(id: string) { this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'at-exit', ':id': id }); }

  applyEvent(type: string, payload: Record<string, unknown>) {
    if (type !== 'car_spot_action') return;
    const plate = String(payload.CarName || payload.carName || payload.Plate || payload.plate || '');
    const spot = String(payload.SpotName || payload.spotName || payload.Destination || payload.destination || '');
    if (!plate) return;
    const runId = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { ':key': 'run_id' })?.value;
    const session = this.db.get<{ id: string; spot_id: string | null }>('SELECT id, spot_id FROM parking_sessions WHERE plate = :plate AND run_id = :run ORDER BY started_at DESC LIMIT 1', { ':plate': plate, ':run': runId || '' });
    if (!session) return;
    if (spot.toLowerCase().includes('exit')) {
      const current = this.db.get<{ status: string }>('SELECT status FROM parking_sessions WHERE id = :id', { ':id': session.id });
      if (current?.status !== 'departure-pending') this.markAtExit(session.id);
    }
    else {
      this.db.run('UPDATE parking_sessions SET status = :status WHERE id = :id', { ':status': 'parked', ':id': session.id });
      if (session.spot_id) this.db.run('UPDATE spots SET occupied = 1, reserved = 0 WHERE id = :id', { ':id': session.spot_id });
    }
  }
}
