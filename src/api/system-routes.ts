import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { currentUser } from './auth-guard.js';
import type { SimulatorGateway } from '../simulator/contracts.js';
import type { AuditService } from '../services/audit.js';
import type { CommandService } from '../services/command-service.js';
import type { EventService } from '../services/event-service.js';
import type { RecoveryService } from '../services/recovery-service.js';

export function registerSystemRoutes(app: FastifyInstance, auth: AuthService, gateway: SimulatorGateway, events: EventService, commands: CommandService, audit: AuditService, recovery: RecoveryService) {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const health = gateway.health(); const run = recovery.status(); const admin = auth.hasAdmin();
    if (health.connected && admin && run.status === 'active') return { status: 'ready', health, run };
    return reply.code(503).send({ status: 'not-ready', health, run, checks: { admin, simulator: health.connected, activeRun: run.status === 'active' } });
  });
  app.get('/api/v1/status', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return { gateway: gateway.health(), run: recovery.status() }; });
  app.get('/api/v1/events', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return events.list(); });
  app.get('/api/v1/commands', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return commands.list(); });
  app.get('/api/v1/audit', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return audit.list(); });
}
