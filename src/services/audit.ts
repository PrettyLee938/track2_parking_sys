import type { Database } from '../db/database.js';

export class AuditService {
  constructor(private readonly db: Database, private readonly clock = () => Date.now()) {}

  record(action: string, entityType: string, entityId: string | undefined, details: Record<string, unknown>, actorId?: string, correctsId?: number) {
    this.db.run('INSERT INTO audit (actor_id, action, entity_type, entity_id, details_json, created_at, corrects_id) VALUES (:actor, :action, :type, :entity, :details, :created, :corrects)', {
      ':actor': actorId || null, ':action': action, ':type': entityType, ':entity': entityId || null,
      ':details': JSON.stringify(details), ':created': new Date(this.clock()).toISOString(), ':corrects': correctsId || null
    });
  }

  list(limit = 100) {
    return this.db.all('SELECT * FROM audit ORDER BY id DESC LIMIT :limit', { ':limit': limit });
  }
}
