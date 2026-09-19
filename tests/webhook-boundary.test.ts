import { describe, expect, it } from 'vitest';
import { signatureDigest } from '../src/simulator/signature.js';
import { WebhookBoundary } from '../src/simulator/webhook-boundary.js';

describe('simulator webhook boundary', () => {
  it('uses EventClass as the event type', () => {
    const payload = { EventClass: 'payment_made', CarPlateNumber: 'ABC 123', Amount: '1.00', EventId: 'event-1', SequenceId: 4 };
    const accepted = new WebhookBoundary().accept({ ...payload, Signature: signatureDigest(payload) });
    expect(accepted.valid).toBe(true);
    expect(accepted.type).toBe('payment_made');
    expect(accepted.eventId).toBe('event-1');
    expect(accepted.sequenceId).toBe(4);
  });

  it('assigns the discovered local run to payloads without RunId', () => {
    const boundary = new WebhookBoundary();
    boundary.setRunId('local-run');
    const payload = { EventClass: 'test_webhook', EventId: 'event-2', SequenceId: 5 };
    expect(boundary.accept({ ...payload, Signature: signatureDigest(payload) }).runId).toBe('local-run');
  });
});
