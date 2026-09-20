/** Movement evidence used by the zone-lighting policy. */
export interface LightingMovementCar {
  plate: string;
  status: string;
  entry_lane: string | null;
  exit_lane: string | null;
  spot: string | null;
}

export interface LightingMovementLane {
  zone: string;
  current?: string | null;
}

export interface ZoneMovement {
  movingVehicles: number;
  known: boolean;
}

/**
 * Count active vehicle movements using controller state, not webhook silence.
 * Unknown-location visits suppress automation in every identifiable affected
 * zone; if their zone cannot be established, suppress it for all zones.
 */
export function countZoneMovements(input: {
  zones: string[];
  cars: LightingMovementCar[];
  entryLanes: Record<string, LightingMovementLane>;
  exitLanes: Record<string, LightingMovementLane>;
  spotZones: Record<string, string>;
}): Record<string, ZoneMovement> {
  const output: Record<string, ZoneMovement> = Object.fromEntries(
    [...new Set(input.zones)].map((zone) => [zone, { movingVehicles: 0, known: true }]),
  );
  let unknownEverywhere = false;

  const zoneFor = (car: LightingMovementCar): string | null => {
    if (car.status === "dispatching" || car.status === "dispatched" || car.status === "entering" || car.status === "turned_away") {
      return car.entry_lane ? input.entryLanes[car.entry_lane]?.zone ?? null : null;
    }
    if (car.status === "to_exit" || car.status === "released") {
      return (car.spot ? input.spotZones[car.spot] : undefined) ??
        (car.exit_lane ? input.exitLanes[car.exit_lane]?.zone : undefined) ?? null;
    }
    return null;
  };

  for (const car of input.cars) {
    if (["dispatching", "dispatched", "entering", "turned_away", "to_exit", "released"].includes(car.status)) {
      const zone = zoneFor(car);
      if (!zone || !output[zone]) {
        unknownEverywhere = true;
        continue;
      }
      output[zone].movingVehicles++;
      continue;
    }
    if (car.status === "unknown" || car.status === "lost") {
      const candidates = new Set<string>();
      if (car.entry_lane && input.entryLanes[car.entry_lane]) candidates.add(input.entryLanes[car.entry_lane].zone);
      if (car.exit_lane && input.exitLanes[car.exit_lane]) candidates.add(input.exitLanes[car.exit_lane].zone);
      if (car.spot && input.spotZones[car.spot]) candidates.add(input.spotZones[car.spot]);
      if (!candidates.size) unknownEverywhere = true;
      for (const zone of candidates) if (output[zone]) output[zone].known = false;
    }
  }

  // A lane pointer without a corresponding active vehicle is an integrity gap:
  // the controller can no longer prove whether a car is moving through the zone.
  for (const [, lane] of Object.entries(input.entryLanes)) {
    if (lane.current && !input.cars.some((car) => car.plate === lane.current &&
        ["dispatching", "dispatched", "entering"].includes(car.status))) {
      if (output[lane.zone]) output[lane.zone].known = false;
      else unknownEverywhere = true;
    }
  }

  if (unknownEverywhere) for (const movement of Object.values(output)) movement.known = false;
  return output;
}
