/**
 * Fail-closed planner for Level 2 zone lighting.
 *
 * The caller is responsible for supplying an explicitly available calibrated
 * calendar and a trustworthy count of moving vehicles for each zone. This pure
 * function never guesses either input and never performs simulator I/O.
 */

export interface LightingCalendarState {
  status: "available" | "unavailable";
  isNight?: boolean;
  reason?: string;
}

export interface LightingZoneState {
  zone: string;
  movingVehicles: number | null;
  movementKnown: boolean;
  inventoryComplete: boolean;
  lights: Array<{
    name: string;
    /** null means the list endpoint did not establish the physical state. */
    isOn: boolean | null;
    /** A light may only be commanded when both safety facts are known and clear. */
    operable: boolean | null;
  }>;
}

export interface LightingCommand {
  light: string;
  action: "on" | "off";
}

export interface LightingZoneDecision {
  zone: string;
  status: "ready" | "unavailable";
  desiredOn: boolean | null;
  reason: string | null;
  commands: LightingCommand[];
  skippedLights: Array<{ light: string; reason: string }>;
}

/**
 * Plan only the commands justified by known state. An incomplete inventory or
 * uncertain movement suppresses all commands in that zone: commanding only the
 * subset we happened to discover could leave the rest of the zone unsafe.
 */
export function planZoneLighting(
  calendar: LightingCalendarState,
  zone: LightingZoneState,
): LightingZoneDecision {
  const unavailable = (reason: string): LightingZoneDecision => ({
    zone: zone.zone,
    status: "unavailable",
    desiredOn: null,
    reason,
    commands: [],
    skippedLights: [],
  });

  if (calendar.status !== "available" || typeof calendar.isNight !== "boolean") {
    return unavailable(calendar.reason ?? "simulator calendar is not calibrated in this process");
  }
  if (!zone.movementKnown || zone.movingVehicles === null || !Number.isInteger(zone.movingVehicles) || zone.movingVehicles < 0) {
    return unavailable("vehicle movement in this zone is uncertain");
  }
  if (!zone.inventoryComplete) return unavailable("light inventory is incomplete or ambiguous");

  const desiredOn = calendar.isNight && zone.movingVehicles > 0;
  const commands: LightingCommand[] = [];
  const skippedLights: LightingZoneDecision["skippedLights"] = [];

  for (const light of zone.lights) {
    if (light.operable !== true) {
      skippedLights.push({ light: light.name, reason: light.operable === false
        ? "light is broken or under maintenance"
        : "light operability is unknown" });
      continue;
    }
    if (light.isOn !== desiredOn) commands.push({ light: light.name, action: desiredOn ? "on" : "off" });
  }

  return { zone: zone.zone, status: "ready", desiredOn, reason: null, commands, skippedLights };
}
