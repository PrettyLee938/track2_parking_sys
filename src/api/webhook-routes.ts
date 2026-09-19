import type { FastifyInstance } from 'fastify';
import type { EventService } from '../services/event-service.js';
import type { EventController } from '../services/event-controller.js';

export function registerWebhookRoutes(app: FastifyInstance, events: EventService, controller: EventController) {
  app.post('/webhooks/simulator', { schema: { body: { type: 'object', additionalProperties: true } } }, async (request, reply) => {
    const payload = (request.body || {}) as Record<string, unknown>;
    const result = events.ingest(payload);
    if (!result.accepted) return reply.code(401).send({ error: result.reason });
    if (result.event && result.ordering === 'in-order') await controller.apply(result.event);
    return reply.code(result.ordering === 'duplicate' ? 200 : 202).send({ accepted: true, ordering: result.ordering, replayRequired: result.ordering !== 'in-order' && result.ordering !== 'duplicate', eventId: result.event?.eventId });
  });
}
