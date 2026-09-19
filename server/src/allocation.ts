/**
 * Spot allocation strategies: which free spot an arriving car is sent to.
 *
 * Pick one with GPA_ALLOCATION_STRATEGY. To add a strategy, extend Allocator and
 * register it in STRATEGIES.
 */
import { CarType, SpotPurpose } from "@gpa/shared";

/** The part of a spot an allocator looks at. */
export interface AllocSpot {
  name: string;
  zone: string;
  purpose: string;
  car_type: string;
  readonly available: boolean;
  accepts(carType: string): boolean;
}

export function spotNumber(name: string): number {
  const digits = name.replace(/\D/g, "");
  return digits ? Number(digits) : 1e9;
}

/** Base: any free spot of a compatible type, in any zone. */
export class Allocator {
  static readonly id: string = "any_zone_first_free";

  inScope(_spot: AllocSpot, _laneZone: string, _all: AllocSpot[]): boolean {
    return true;
  }

  candidates<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>): S[] {
    const all = [...spots];
    return all.filter((s) => s.available && s.accepts(carType) && this.inScope(s, laneZone, all));
  }

  /** Whether cars queued at lanes of these two zones compete for the same spots. */
  sharesPool(_zoneA: string, _zoneB: string): boolean {
    return true;
  }

  /** A spot built for this car type first (an electric car to a charger), then generic
   * spots. Normal cars never reach typed spots: accepts() excludes them. */
  rank(s: AllocSpot): [number, number] {
    return [s.car_type === CarType.Any ? 1 : 0, spotNumber(s.name)];
  }

  choose<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>): S | null {
    const found = this.candidates(carType, laneZone, spots);
    if (!found.length) return null;
    return found.reduce((best, s) => {
      const [a1, a2] = this.rank(s), [b1, b2] = this.rank(best);
      return a1 < b1 || (a1 === b1 && a2 < b2) ? s : best;
    });
  }
}

/**
 * Only spots in the zone the entry lane leads to. Zones marked "Closed" in the
 * simulator are separate areas: a car sent to another zone may not reach it. Falls
 * back to every zone when the lane's zone is unknown or has no parking at all.
 */
export class LaneZoneAllocator extends Allocator {
  static override readonly id = "lane_zone_first_free";

  override inScope(spot: AllocSpot, laneZone: string, all: AllocSpot[]): boolean {
    if (!laneZone || !all.some((s) => s.zone === laneZone && s.purpose === SpotPurpose.Park)) return true;
    return spot.zone === laneZone;
  }

  override sharesPool(a: string, b: string): boolean {
    return !a || !b || a === b;
  }
}

export const STRATEGIES: Record<string, new () => Allocator> = {
  [Allocator.id]: Allocator,
  [LaneZoneAllocator.id]: LaneZoneAllocator,
};

export function getAllocator(name: string): Allocator {
  const cls = STRATEGIES[name];
  if (!cls) throw new Error(`unknown allocation strategy '${name}'; choose from ${Object.keys(STRATEGIES).sort().join(", ")}`);
  return new cls();
}
