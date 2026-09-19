import type { InvoiceInput, InvoiceTotal } from './types.js';

const roundCents = (value: number) => Math.round(value);

export function calculateInvoice(input: InvoiceInput): InvoiceTotal {
  const parkingCents = roundCents(input.durationMinutes * input.parkingRateCentsPerHour / 60);
  const electricityCents = roundCents(input.electricityKwh * input.electricityRateCentsPerKwh);
  return { parkingCents, electricityCents, totalCents: parkingCents + electricityCents };
}
