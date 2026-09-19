import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { adminUser, currentUser } from './auth-guard.js';
import type { RecoveryService } from '../services/recovery-service.js';
import * as schema from './schemas.js';
import type { CommandService } from '../services/command-service.js';

export function registerRecoveryRoutes(app: FastifyInstance, auth: AuthService, recovery: RecoveryService, commands: CommandService) {
  app.get('/api/v1/runs/current', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return recovery.status(); });
  app.post('/api/v1/runs/reconcile', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return recovery.reconcile(); });
  app.post('/api/v1/runs/close', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; return recovery.closeRun(user.id); });
  app.post('/api/v1/runs/new', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; return recovery.startNewRun(user.id); });
  app.post('/api/v1/runs/continue', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; try { return await recovery.continueRun(user.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'run-continue-failed' }); } });
  app.post('/api/v1/commands/:id/cancel', { schema: schema.idParams }, async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; commands.cancel((request.params as { id: string }).id, user.id); return { status: 'cancelled' }; });
  app.post('/api/v1/audit/:id/correct', { schema: schema.correction }, async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; recovery.correctAudit(user.id, Number((request.params as { id: string }).id), request.body as Record<string, unknown>); return { status: 'recorded' }; });
}
