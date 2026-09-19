import type { NormalizedEvent } from '../domain/types.js';
import type { CommandService } from './command-service.js';
import type { EquipmentService } from './equipment-service.js';
import type { ParkingService } from './parking-service.js';
import type { PaymentService } from './payment-service.js';

export class EventController {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly parking: ParkingService,
    private readonly payments: PaymentService,
    private readonly commands: CommandService
  ) {}

  async apply(event: NormalizedEvent) {
    await this.equipment.applyEvent({ type: event.type, payload: event.payload, eventId: event.eventId });
    if (event.type === 'car_spot_action') await this.parking.handleEntryEvent(event.payload, event.eventId);
    if (event.type === 'gate_action') await this.parking.handleGateEvent(event.payload);
    this.parking.applyEvent(event.type, event.payload);
    await this.payments.applyEvent(event.type, event.payload);
    this.commands.confirmFromEvent(event.payload);
  }
}
