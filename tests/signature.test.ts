import { describe, expect, it } from 'vitest';
import { canonicalSignature, verifySignature } from '../src/simulator/signature.js';

describe('simulator webhook signatures', () => {
  it('builds the canonical value order without Signature', () => {
    const payload = { Type: 'test_webhook', Signature: 'ignored', SequenceId: '2', EventId: 'e-1' };
    expect(canonicalSignature(payload)).toBe('e-1|2|test_webhook');
  });

  it('accepts a known valid digest and rejects a changed payload', () => {
    const payload = { Type: 'test_webhook', SequenceId: '2', EventId: 'e-1' };
    expect(verifySignature(payload, 'd877c55aa71f577a50f390b83c450d49')).toBe(true);
    expect(verifySignature({ ...payload, SequenceId: '3' }, 'd877c55aa71f577a50f390b83c450d49')).toBe(false);
  });

  it('handles a lowercase signature field from a webhook client', () => {
    const payload = { Type: 'test_webhook', SequenceId: '2', EventId: 'e-1' };
    expect(verifySignature({ ...payload, signature: 'd877c55aa71f577a50f390b83c450d49' }, 'd877c55aa71f577a50f390b83c450d49')).toBe(true);
  });
});
