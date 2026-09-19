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

/** What the controller knows beyond the spots themselves (optional for every strategy). */
export interface AllocContext {
  /** Extra cost of sending this car to a zone - a worn or broken exit gate, say.
   * null = do not use this zone at all (e.g. learned unreachable from this entrance). */
  zoneCost?(zone: string): number | null;
  /** How worn a spot is (uses since its last repair): spread wear among equal spots. */
  spotWear?(name: string): number;
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

  candidates<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>, ctx: AllocContext = {}): S[] {
    const all = [...spots];
    return all.filter((s) => s.available && s.accepts(carType) && this.inScope(s, laneZone, all) &&
      (!ctx.zoneCost || ctx.zoneCost(s.zone) !== null));
  }

  /** Whether cars queued at lanes of these two zones compete for the same spots. */
  sharesPool(_zoneA: string, _zoneB: string): boolean {
    return true;
  }

  /** A spot built for this car type first (an electric car to a charger), then generic
   * spots. Normal cars never reach typed spots: accepts() excludes them. */
  rank(s: AllocSpot, _laneZone = ""): [number, number] {
    return [s.car_type === CarType.Any ? 1 : 0, spotNumber(s.name)];
  }

  choose<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>, ctx: AllocContext = {}): S | null {
    const found = this.candidates(carType, laneZone, spots, ctx);
    if (!found.length) return null;
    return found.reduce((best, s) => {
      const [a1, a2] = this.rank(s), [b1, b2] = this.rank(best);
      return a1 < b1 || (a1 === b1 && a2 < b2) ? s : best;
    });
  }
}

/**
 * Spread cars - and so wear - across zones. Every free spot the car may take is scored:
 *   zone load      share of the zone's spots taken: fuller zones cost more
 *   home zone      the entrance's own zone is preferred by HOME_PREFERENCE (a car only goes
 *                  elsewhere once its own zone is that much busier)
 *   zone cost      from the controller: a broken, under-repair or worn exit gate (context)
 *   spot type      a spot built for the car's type (charger, accessible) first
 * then, among equal spots, the least worn one. 2026-09-20 run: every car came in at ENTRY1,
 * ZONE1's 30 spots were full while ZONE2/3's 60 sat empty, and 36% of arrivals were turned
 * away; its one exit gate took all the exits' wear.
 */
export class ZoneBalancedAllocator extends Allocator {
  static override readonly id = "zone_balanced";
  static readonly HOME_PREFERENCE = 0.25;
  static readonly TYPE_MISMATCH = 0.3;

  override choose<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>, ctx: AllocContext = {}): S | null {
    const all = [...spots];
    const found = this.candidates(carType, laneZone, all, ctx);
    if (!found.length) return null;
    const load = new Map<string, number>();
    for (const zone of new Set(found.map((s) => s.zone))) {
      const park = all.filter((s) => s.zone === zone && s.purpose === SpotPurpose.Park);
      load.set(zone, park.filter((s) => !s.available).length / Math.max(1, park.length));
    }
    const score = (s: S): [number, number, number] => [
      load.get(s.zone)! + (laneZone && s.zone !== laneZone ? ZoneBalancedAllocator.HOME_PREFERENCE : 0) +
        (ctx.zoneCost?.(s.zone) ?? 0) + (this.rank(s)[0] ? ZoneBalancedAllocator.TYPE_MISMATCH : 0),
      ctx.spotWear?.(s.name) ?? 0,
      spotNumber(s.name),
    ];
    return found.reduce((best, s) => {
      const a = score(s), b = score(best);
      return a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) < 1e-9 && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]))) ? s : best;
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

/**
 * The lane's own zone first; when it is full, any other zone. Level 2 run 2026-09-20: every
 * car came in at ENTRY1, so with lane_zone_first_free ZONE2 and ZONE3 (60 spots) sat empty
 * while ENTRY1 turned cars away. Only useful if cars can drive from an entrance to the
 * other zones - watch for "cannot reach" penalties when trying it.
 */
export class LaneZoneOverflowAllocator extends Allocator {
  static override readonly id = "lane_zone_then_any";

  override rank(s: AllocSpot, laneZone = ""): [number, number] {
    const [typed, number] = super.rank(s);
    return [(laneZone && s.zone !== laneZone ? 2 : 0) + typed, number];
  }

  override choose<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>, ctx: AllocContext = {}): S | null {
    const found = this.candidates(carType, laneZone, spots, ctx);
    if (!found.length) return null;
    return found.reduce((best, s) => {
      const [a1, a2] = this.rank(s, laneZone), [b1, b2] = this.rank(best, laneZone);
      return a1 < b1 || (a1 === b1 && a2 < b2) ? s : best;
    });
  }
}

export const STRATEGIES: Record<string, new () => Allocator> = {
  [Allocator.id]: Allocator,
  [LaneZoneAllocator.id]: LaneZoneAllocator,
  [LaneZoneOverflowAllocator.id]: LaneZoneOverflowAllocator,
  [ZoneBalancedAllocator.id]: ZoneBalancedAllocator,
};

export function getAllocator(name: string): Allocator {
  const cls = STRATEGIES[name];
  if (!cls) throw new Error(`unknown allocation strategy '${name}'; choose from ${Object.keys(STRATEGIES).sort().join(", ")}`);
  return new cls();
}
