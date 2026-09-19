import type { AllocationRequest, SpotCandidate } from './types.js';

function legal(spot: SpotCandidate, request: AllocationRequest): boolean {
  if (spot.occupied || spot.reserved || spot.broken || spot.underMaintenance) return false;
  if (!spot.reachable || !spot.zoneSafe || (request.accessible && !spot.accessible)) return false;
  if (request.needsCharging && spot.type !== 'electric') return false;
  if (request.carType === 'electric' && spot.type === 'accessible') return false;
  return spot.type === 'any' || spot.type === request.carType || (request.carType === 'normal' && spot.type === 'accessible');
}

export function chooseSpot(request: AllocationRequest) {
  const candidate = request.spots.filter((spot) => legal(spot, request)).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))[0];
  return candidate ? { spotId: candidate.id, reason: 'legal-ranked-candidate' as const } : { spotId: null, reason: 'no-legal-candidate' as const };
}
