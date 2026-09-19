import { describe, expect, it } from 'vitest';
import { calculateInvoice } from '../src/domain/billing.js';

describe('parking invoices', () => {
  it('uses exact cents and rounds only at the billing boundary', () => {
    expect(calculateInvoice({ durationMinutes: 95, parkingRateCentsPerHour: 125, electricityKwh: 3.2, electricityRateCentsPerKwh: 40 })).toEqual({ parkingCents: 198, electricityCents: 128, totalCents: 326 });
  });

  it('does not charge electricity when no electricity was used', () => {
    expect(calculateInvoice({ durationMinutes: 60, parkingRateCentsPerHour: 100, electricityKwh: 0, electricityRateCentsPerKwh: 40 })).toEqual({ parkingCents: 100, electricityCents: 0, totalCents: 100 });
  });
});
