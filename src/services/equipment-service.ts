import type { Database } from '../db/database.js';
import { AuditService } from './audit.js';
import type { CommandService } from './command-service.js';

type EventInput = { type: string; payload: Record<string, unknown>; eventId?: string };
const pick = (payload: Record<string, unknown>, ...keys: string[]) => keys.map((key) => payload[key]).find((value) => value !== undefined && value !== null);
const kindName = (value: unknown) => String(value || 'component').toLowerCase().replace(/[^a-z]/g, '');

function repairTarget(kind: string, id: string) {
  const normalized = kindName(kind);
  if (normalized.includes('barrier') || normalized.includes('gate')) return `/api/v1/barrier-gates/${encodeURIComponent(id)}/repair`;
  if (normalized.includes('fan') || normalized.includes('exhaust')) return `/api/v1/exhaust-fans/${encodeURIComponent(id)}/repair`;
  if (normalized.includes('spot') || normalized.includes('parking')) return `/api/v1/parking-spots/${encodeURIComponent(id)}/repair`;
  throw new Error('component-repair-unsupported');
}

export class EquipmentService {
  constructor(private readonly db: Database, private readonly commands: CommandService, private readonly audit = new AuditService(db), private readonly clock = () => Date.now(), private readonly coThreshold = 50) {}

  async applyEvent(event: EventInput) {
    const id = String(pick(event.payload, 'ComponentId', 'componentId', 'Name', 'name') || pick(event.payload, 'ZoneId', 'zoneId') || 'unknown');
    const now = new Date(this.clock()).toISOString();
    if (event.type === 'component_broken') this.save(id, String(pick(event.payload, 'Type', 'type', 'ComponentType', 'componentType', 'Kind', 'kind') || 'component'), 'broken', undefined, now, String(pick(event.payload, 'ZoneName', 'zoneName', 'ZoneId', 'zoneId') || ''));
    if (event.type === 'component_fixed') this.save(id, String(pick(event.payload, 'Type', 'type', 'ComponentType', 'componentType', 'Kind', 'kind') || 'component'), 'healthy', undefined, now, String(pick(event.payload, 'ZoneName', 'zoneName', 'ZoneId', 'zoneId') || ''));
    if (event.type === 'gate_action') this.save(id, 'barrier-gate', String(pick(event.payload, 'Action', 'action') || 'unknown').toLowerCase(), undefined, now, String(pick(event.payload, 'ZoneName', 'zoneName', 'ZoneId', 'zoneId') || ''));
    if (event.type === 'carbon_monoxide_event') {
      const zone = String(pick(event.payload, 'ZoneName', 'zoneName', 'ZoneId', 'zoneId') || 'unknown');
      const level = Number(pick(event.payload, 'CarbonMonoxideLevel', 'carbonMonoxideLevel', 'CoLevel', 'coLevel', 'CarbonMonoxide') || 0);
      this.save(`zone:${zone}`, 'zone', 'observed', level, now, zone);
      const fans = this.db.all<{ id: string }>('SELECT id FROM components WHERE kind IN (\'fan\', \'exhaust-fan\') AND zone_id = :zone', { ':zone': zone });
      for (const fan of fans) {
        try { await this.setFan(fan.id, level >= this.coThreshold, undefined, event.eventId ? `${event.eventId}:${fan.id}` : undefined); }
        catch (error) { this.audit.record('equipment-command-deferred', 'component', fan.id, { reason: error instanceof Error ? error.message : String(error), coLevel: level }); }
      }
    }
  }

  private save(id: string, kind: string, status: string, coLevel: number | undefined, updatedAt: string, zoneId?: string) {
    this.db.run('INSERT INTO components (id, kind, zone_id, status, co_level, updated_at) VALUES (:id, :kind, :zone, :status, :co, :updated) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, zone_id=excluded.zone_id, status=excluded.status, co_level=excluded.co_level, updated_at=excluded.updated_at', { ':id': id, ':kind': kind, ':zone': zoneId || null, ':status': status, ':co': coLevel ?? null, ':updated': updatedAt });
  }

  async requestRepair(id: string, actorId?: string) {
    const component = this.db.get<{ status: string; kind: string }>('SELECT status, kind FROM components WHERE id = :id', { ':id': id });
    if (!component || component.status !== 'broken') throw new Error('component-not-repairable');
    if (kindName(component.kind).includes('spot') || kindName(component.kind).includes('parking')) {
      if (this.db.get('SELECT id FROM spots WHERE id = :id AND occupied = 1', { ':id': id })) throw new Error('component-in-use');
    }
    const command = await this.commands.issue({ kind: 'component.repair', target: repairTarget(component.kind, id), payload: { componentId: id } }, actorId);
    this.db.transaction(() => {
      this.save(id, component.kind, 'repair-requested', undefined, new Date(this.clock()).toISOString(), '');
      this.audit.record('repair-requested', 'component', id, { commandId: command.id }, actorId);
    });
    return { id, status: 'repair-requested' as const, commandId: command.id };
  }

  async setFan(id: string, enabled: boolean, actorId?: string, sourceEventId?: string) { return this.issueEquipmentCommand('fan.set', id, enabled, actorId, sourceEventId); }
  async setLight(id: string, enabled: boolean, actorId?: string) { return this.issueEquipmentCommand('light.set', id, enabled, actorId); }

  async setGate(id: string, action: 'open' | 'close', actorId?: string) {
    const component = this.db.get<{ status: string; kind: string }>('SELECT status, kind FROM components WHERE id = :id', { ':id': id });
    if (!component) throw new Error('component-not-found');
    if (['broken', 'under-maintenance', 'repair-requested'].includes(component.status)) throw new Error('component-unavailable');
    const command = await this.commands.issue({ kind: `gate.${action}`, target: `/api/v1/barrier-gates/${encodeURIComponent(id)}/${action}`, payload: { id, action } }, actorId);
    this.audit.record('equipment-command-requested', 'component', id, { kind: `gate.${action}`, commandId: command.id }, actorId);
    return command;
  }

  private async issueEquipmentCommand(kind: string, id: string, enabled: boolean, actorId?: string, sourceEventId?: string) {
    const component = this.db.get<{ status: string }>('SELECT status FROM components WHERE id = :id', { ':id': id });
    if (component && ['broken', 'under-maintenance', 'repair-requested'].includes(component.status)) throw new Error('component-unavailable');
    if (kind === 'fan.set' && !enabled && this.db.get('SELECT id FROM components WHERE kind = :kind AND co_level >= :threshold', { ':kind': 'zone', ':threshold': this.coThreshold })) throw new Error('fan-required-for-co');
    const resource = kind === 'fan.set' ? 'exhaust-fans' : 'lights';
    const action = enabled ? 'on' : 'off';
    const command = await this.commands.issue({ kind, target: `/api/v1/${resource}/${encodeURIComponent(id)}/${action}`, payload: { id, enabled, ...(sourceEventId ? { sourceEventId } : {}) } }, actorId);
    this.audit.record('equipment-command-requested', 'component', id, { kind, enabled, commandId: command.id }, actorId);
    return command;
  }

  list(limit = 100) { return this.db.all('SELECT * FROM components ORDER BY id LIMIT :limit', { ':limit': limit }); }
}
