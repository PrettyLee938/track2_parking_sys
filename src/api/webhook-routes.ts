import type { FastifyInstance } from 'fastify';
import type { EquipmentService } from '../services/equipment-service.js';
import type { EventService } from '../services/event-service.js';
import type { CommandService } from '../services/command-service.js';
import type { ParkingService } from '../services/parking-service.js';
import type { PaymentService } from '../services/payment-service.js';

export function registerWebhookRoutes(app: FastifyInstance, events: EventService, equipment: EquipmentService, commands: CommandService, parking: ParkingService, payments: PaymentService) {
  app.post('/webhooks/simulator', async (request, reply) => {
    const payload = (request.body || {}) as Record<string, unknown>;
    const result = events.ingest(payload);
    if (!result.accepted) return reply.code(401).send({ error: result.reason });
    if (result.event) {
      equipment.applyEvent({ type: result.event.type, payload: result.event.payload });
      parking.applyEvent(result.event.type, result.event.payload);
      await payments.applyEvent(result.event.type, result.event.payload);
      commands.confirmFromEvent(result.event.payload);
    }
    return reply.code(result.ordering === 'duplicate' ? 200 : 202).send({ accepted: true, ordering: result.ordering, eventId: result.event?.eventId });
  });
}
