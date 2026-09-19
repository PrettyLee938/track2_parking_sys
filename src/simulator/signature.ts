import { createHash, timingSafeEqual } from 'node:crypto';

export function canonicalSignature(payload: Record<string, unknown>): string {
  return Object.keys(payload).filter((key) => key !== 'Signature').sort().map((key) => String(payload[key] ?? '')).join('|');
}

export function signatureDigest(payload: Record<string, unknown>): string {
  return createHash('md5').update(canonicalSignature(payload)).digest('hex');
}

export function verifySignature(payload: Record<string, unknown>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signatureDigest(payload).toLowerCase());
  const actual = Buffer.from(signature.toLowerCase());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
