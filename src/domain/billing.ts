import type { InvoiceInput, InvoiceTotal } from './types.js';

const scaled = (value: number, scale: bigint) => {
  const text = String(value);
  const [whole, fraction = ''] = text.split('.');
  const digits = fraction.padEnd(3, '0').slice(0, 3);
  return BigInt(whole || '0') * scale + BigInt(digits || '0');
};

const toSafeNumber = (value: bigint) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('invoice-overflow');
  return result;
};

export function calculateInvoice(input: InvoiceInput): InvoiceTotal {
  const parkingNumerator = BigInt(input.durationMinutes) * BigInt(input.parkingRateCentsPerHour);
  const parkingCents = toSafeNumber((parkingNumerator + 30n) / 60n);
  const electricityNumerator = scaled(input.electricityKwh, 1000n) * BigInt(input.electricityRateCentsPerKwh);
  const electricityCents = toSafeNumber((electricityNumerator + 500n) / 1000n);
  return { parkingCents, electricityCents, totalCents: parkingCents + electricityCents };
}
