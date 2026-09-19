import type { FastifyInstance } from 'fastify';
import type { EventService } from '../services/event-service.js';
import type { EventController } from '../services/event-controller.js';

export function registerWebhookRoutes(app: FastifyInstance, events: EventService, controller: EventController) {
  let tail = Promise.resolve();
  app.post('/webhooks/simulator', { schema: { body: { type: 'object', additionalProperties: true } } }, async (request, reply) => {
    const payload = (request.body || {}) as Record<string, unknown>;
    const operation = async () => {
      const result = events.ingest(payload);
      if (!result.accepted) return { status: 401, body: { error: result.reason } };
      if (result.readyEvents) for (const event of result.readyEvents) { await controller.apply(event); events.markProcessed(event.eventId); }
      return { status: result.ordering === 'duplicate' ? 200 : 202, body: { accepted: true, ordering: result.ordering, replayRequired: result.ordering !== 'in-order' && result.ordering !== 'duplicate', eventId: result.event?.eventId } };
    };
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    const result = await next;
    return reply.code(result.status).send(result.body);
  });
}
