import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { adminUser, currentUser } from './auth-guard.js';
import type { RecoveryService } from '../services/recovery-service.js';

export function registerRecoveryRoutes(app: FastifyInstance, auth: AuthService, recovery: RecoveryService) {
  app.get('/api/v1/runs/current', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return recovery.status(); });
  app.post('/api/v1/runs/reconcile', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return recovery.reconcile(); });
  app.post('/api/v1/runs/close', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; return recovery.closeRun(user.id); });
  app.post('/api/v1/runs/new', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; return recovery.startNewRun(user.id); });
  app.post('/api/v1/runs/continue', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; return recovery.continueRun(user.id); });
  app.post('/api/v1/audit/:id/correct', async (request, reply) => { const user = await adminUser(request, reply, auth); if (!user) return; recovery.correctAudit(user.id, Number((request.params as { id: string }).id), request.body as Record<string, unknown>); return { status: 'recorded' }; });
}
