import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${digest.toString('base64')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [, saltText, digestText] = encoded.split(':');
  if (!saltText || !digestText) return false;
  const expected = Buffer.from(digestText, 'base64');
  const actual = scryptSync(password, Buffer.from(saltText, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}
