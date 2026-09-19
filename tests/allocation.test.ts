import { describe, expect, it } from 'vitest';
import { chooseSpot } from '../src/domain/allocation.js';

describe('parking allocation', () => {
  it('chooses the first legal candidate using deterministic ranking', () => {
    const result = chooseSpot({
      carType: 'electric',
      accessible: false,
      needsCharging: true,
      spots: [
        { id: 'E-2', type: 'electric', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 2 },
        { id: 'E-1', type: 'electric', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 },
        { id: 'N-1', type: 'any', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 0 }
      ]
    });
    expect(result).toEqual({ spotId: 'E-1', reason: 'legal-ranked-candidate' });
  });

  it('reports why no candidate is legal', () => {
    const result = chooseSpot({
      carType: 'normal',
      accessible: true,
      needsCharging: false,
      spots: [{ id: 'N-1', type: 'any', accessible: false, occupied: true, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }]
    });
    expect(result).toEqual({ spotId: null, reason: 'no-legal-candidate' });
  });
});
