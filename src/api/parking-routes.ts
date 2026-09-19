import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { adminUser, currentUser } from './auth-guard.js';
import type { ParkingService } from '../services/parking-service.js';
import type { PaymentService } from '../services/payment-service.js';

export function registerParkingRoutes(app: FastifyInstance, auth: AuthService, parking: ParkingService, payments: PaymentService) {
  app.get('/api/v1/parking/sessions', async (request, reply) => { const user = await currentUser(request, reply, auth); if (!user) return; return parking.listSessions(); });

  app.post('/api/v1/parking/arrivals', async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return reply.code(201).send(await parking.createArrival(request.body as never, user.id)); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'arrival-rejected' }); }
  });

  app.post('/api/v1/parking/sessions/:id/at-exit', async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    parking.markAtExit((request.params as { id: string }).id); return { status: 'at-exit' };
  });

  app.post('/api/v1/parking/sessions/:id/invoice', async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return reply.code(201).send(await payments.createInvoice((request.params as { id: string }).id, request.body as never)); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invoice-rejected' }); }
  });

  app.post('/api/v1/parking/sessions/:id/payments', async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    const body = request.body as { amountCents?: number; paymentId?: string }; const amountCents = body.amountCents; if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) return reply.code(400).send({ error: 'amountCents-required' });
    return payments.recordPayment((request.params as { id: string }).id, amountCents, body.paymentId);
  });

  app.post('/api/v1/parking/sessions/:id/departure', async (request, reply) => {
    const user = await currentUser(request, reply, auth); if (!user) return;
    try { return await payments.requestDeparture((request.params as { id: string }).id, user.id); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'departure-rejected' }); }
  });

  app.post('/api/v1/parking/sessions/:id/unpaid-release', async (request, reply) => {
    const actor = await adminUser(request, reply, auth); if (!actor) return;
    const body = request.body as { password?: string; reason?: string };
    try { return await payments.authorizeUnpaid((request.params as { id: string }).id, actor, body.password || '', body.reason || ''); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'override-rejected' }); }
  });
}
