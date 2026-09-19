import { randomUUID } from 'node:crypto';
import { signatureDigest, verifySignature } from './signature.js';

const value = (payload: Record<string, unknown>, ...keys: string[]) => keys.map((key) => payload[key]).find((item) => item !== undefined && item !== null);

export interface WebhookEnvelope {
  valid: boolean;
  calculatedDigest: string;
  eventId: string;
  type: string;
  sequenceId: number;
  runId: string | undefined;
  payload: Record<string, unknown>;
  reason: string | undefined;
}

export class WebhookBoundary {
  private activeRunId: string | undefined;

  setRunId(runId: string | undefined) { this.activeRunId = runId; }

  accept(payload: Record<string, unknown>): WebhookEnvelope {
    const signature = value(payload, 'Signature', 'signature');
    const calculatedDigest = signatureDigest(payload);
    const eventId = String(value(payload, 'EventId', 'eventId') || randomUUID());
    if (!verifySignature(payload, signature ? String(signature) : undefined)) return { valid: false, calculatedDigest, eventId, type: 'unknown', sequenceId: 0, runId: undefined, payload, reason: 'invalid-signature' };
    const runId = value(payload, 'RunId', 'runId') || this.activeRunId;
    return { valid: true, calculatedDigest, eventId, type: String(value(payload, 'EventClass', 'eventClass', 'Type', 'type') || 'unknown'), sequenceId: Number(value(payload, 'SequenceId', 'sequenceId') || 0), runId: runId ? String(runId) : undefined, payload, reason: undefined };
  }
}
