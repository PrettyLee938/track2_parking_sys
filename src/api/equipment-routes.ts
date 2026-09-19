import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { currentUser } from './auth-guard.js';
import type { EquipmentService } from '../services/equipment-service.js';
import * as schema from './schemas.js';

export function registerEquipmentRoutes(app: FastifyInstance, auth: AuthService, equipment: EquipmentService) {
  app.get('/api/v1/equipment', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return equipment.list(); });
  app.post('/api/v1/equipment/:id/repair', { schema: schema.idParams }, async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return equipment.requestRepair((request.params as { id: string }).id, user.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'repair-rejected' }); }
  });
  app.post('/api/v1/equipment/:id/fan', { schema: schema.equipment }, async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return await equipment.setFan((request.params as { id: string }).id, Boolean((request.body as { enabled?: boolean }).enabled), user.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'fan-command-rejected' }); }
  });
  app.post('/api/v1/equipment/:id/light', { schema: schema.equipment }, async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return await equipment.setLight((request.params as { id: string }).id, Boolean((request.body as { enabled?: boolean }).enabled), user.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'light-command-rejected' }); }
  });
  app.post('/api/v1/equipment/:id/gate', { schema: schema.gate }, async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return await equipment.setGate((request.params as { id: string }).id, (request.body as { action: 'open' | 'close' }).action, user.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'gate-command-rejected' }); }
  });
}
