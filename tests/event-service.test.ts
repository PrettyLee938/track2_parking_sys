import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { EventService } from '../src/services/event-service.js';
import { signatureDigest } from '../src/simulator/signature.js';

const signed = (payload: Record<string, unknown>) => ({ ...payload, Signature: signatureDigest(payload) });

describe('webhook event boundary', () => {
  it('accepts signed events once and reports sequence gaps', () => {
    const service = new EventService(new Database(':memory:'));
    const first = signed({ EventId: 'e-1', SequenceId: '1', Type: 'test_webhook' });
    expect(service.ingest(first).ordering).toBe('in-order');
    expect(service.ingest(first).ordering).toBe('duplicate');
    const gap = signed({ EventId: 'e-3', SequenceId: '3', Type: 'test_webhook' });
    expect(service.ingest(gap).ordering).toBe('gap');
    expect((service.list()[0] as { signature_digest: string }).signature_digest).toBe(signatureDigest(gap));
  });

  it('rejects invalid signatures before persistence', () => {
    const db = new Database(':memory:');
    const service = new EventService(db);
    expect(service.ingest({ EventId: 'bad', SequenceId: '1', Type: 'test_webhook', Signature: 'bad' }).accepted).toBe(false);
    expect(service.list()).toHaveLength(0);
  });
});
