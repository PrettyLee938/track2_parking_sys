import type { Database } from '../db/database.js';
import { AuditService } from './audit.js';
import type { CommandService } from './command-service.js';

type EventInput = { type: string; payload: Record<string, unknown> };
const pick = (payload: Record<string, unknown>, ...keys: string[]) => keys.map((key) => payload[key]).find((value) => value !== undefined && value !== null);

export class EquipmentService {
  constructor(private readonly db: Database, private readonly commands: CommandService, private readonly audit = new AuditService(db), private readonly clock = () => Date.now(), private readonly coThreshold = 50) {}

  async applyEvent(event: EventInput) {
    const id = String(pick(event.payload, 'ComponentId', 'componentId', 'Name', 'name') || pick(event.payload, 'ZoneId', 'zoneId') || 'unknown');
    const now = new Date(this.clock()).toISOString();
    if (event.type === 'component_broken') this.save(id, String(pick(event.payload, 'ComponentType', 'componentType', 'Kind', 'kind') || 'component'), 'broken', undefined, now, String(pick(event.payload, 'ZoneId', 'zoneId') || ''));
    if (event.type === 'component_fixed') this.save(id, 'component', 'healthy', undefined, now, '');
    if (event.type === 'carbon_monoxide_event') {
      const level = Number(pick(event.payload, 'CoLevel', 'coLevel', 'CarbonMonoxide') || 0);
      this.save(`zone:${id}`, 'zone', 'observed', level, now, id);
      const fanId = pick(event.payload, 'FanId', 'fanId');
      if (fanId) await this.setFan(String(fanId), level >= this.coThreshold);
    }
  }

  private save(id: string, kind: string, status: string, coLevel: number | undefined, updatedAt: string, zoneId?: string) {
    this.db.run('INSERT INTO components (id, kind, zone_id, status, co_level, updated_at) VALUES (:id, :kind, :zone, :status, :co, :updated) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, zone_id=excluded.zone_id, status=excluded.status, co_level=excluded.co_level, updated_at=excluded.updated_at', { ':id': id, ':kind': kind, ':zone': zoneId || null, ':status': status, ':co': coLevel ?? null, ':updated': updatedAt });
  }

  async requestRepair(id: string, actorId?: string) {
    const component = this.db.get<{ status: string; kind: string }>('SELECT status, kind FROM components WHERE id = :id', { ':id': id });
    if (!component || component.status !== 'broken') throw new Error('component-not-repairable');
    const command = await this.commands.issue({ kind: 'component.repair', target: `/api/v1/components/${encodeURIComponent(id)}/repair`, payload: { componentId: id } }, actorId);
    this.db.transaction(() => {
      this.save(id, component.kind, 'repair-requested', undefined, new Date(this.clock()).toISOString(), '');
      this.audit.record('repair-requested', 'component', id, { commandId: command.id }, actorId);
    });
    return { id, status: 'repair-requested' as const, commandId: command.id };
  }

  async setFan(id: string, enabled: boolean, actorId?: string) { return this.issueEquipmentCommand('fan.set', id, enabled, actorId); }
  async setLight(id: string, enabled: boolean, actorId?: string) { return this.issueEquipmentCommand('light.set', id, enabled, actorId); }

  private async issueEquipmentCommand(kind: string, id: string, enabled: boolean, actorId?: string) {
    const component = this.db.get<{ status: string }>('SELECT status FROM components WHERE id = :id', { ':id': id });
    if (component && ['broken', 'under-maintenance', 'repair-requested'].includes(component.status)) throw new Error('component-unavailable');
    if (kind === 'fan.set' && !enabled && this.db.get('SELECT id FROM components WHERE kind = :kind AND co_level >= :threshold', { ':kind': 'zone', ':threshold': this.coThreshold })) throw new Error('fan-required-for-co');
    const command = await this.commands.issue({ kind, target: `/api/v1/${kind.split('.')[0]}s/${encodeURIComponent(id)}`, payload: { id, enabled } }, actorId);
    this.audit.record('equipment-command-requested', 'component', id, { kind, enabled, commandId: command.id }, actorId);
    return command;
  }

  list(limit = 100) { return this.db.all('SELECT * FROM components ORDER BY id LIMIT :limit', { ':limit': limit }); }
}
