/**
 * Environment (Level 2): exhaust fans against carbon monoxide. (Lights: next, same place.)
 *
 * Spec: fans cost electricity - "better to turn off when CO levels are below 50 in a
 * specific zone". So each zone's fans follow its CO level: on at coFanOnLevel and above,
 * off below coFanOffLevel.
 *
 * Where the level comes from: the simulator is documented to send carbon_monoxide_event
 * from level 50 ("Mid") up, but in 2026-09-20's runs it sent NONE - not even while fining
 * us "High CO gas level detected" (8 x 30 in ZONE1). So we ask for it: list-zones, every
 * coPollGameS, but only while it can matter - cars moved in some zone recently (CO is only
 * produced by moving cars) or a fan is running (to know when to switch it off). A CO
 * webhook, if one ever comes, counts as a reading too; a CO penalty forces that zone's
 * fans on until a reading says it is clean again.
 *
 * Only fans that are neither broken nor under repair are switched (operating them otherwise
 * is a penalty). Running time goes to the component registry as usage (game hours) - what
 * preventive maintenance learns a fan's limit from.
 */
import { EventClass, SpotPurpose } from "@gpa/shared";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";

interface ZoneAir {
  level: number | null;   // latest CO reading
  risk: string;
  atG: number | null;     // game clock of that reading
  forced: boolean;        // a CO penalty: fans on until a reading below coFanOffLevel
  want: boolean;          // fans should run
}

export class Environment implements Subsystem {
  readonly name = "environment";
  private zones = new Map<string, ZoneAir>();
  private lastMovementG = new Map<string, number>();
  private nextPollG = 0;
  private lastTickG: number | null = null;
  private pollWarned = false;
  polls = 0;

  constructor(private readonly engine: Engine) {}

  onEvent(e: EventRecord): void {
    const now = this.engine.clock.now();
    if (e.EventClass === EventClass.CarSpotAction) {
      const zone = this.zoneOfCarEvent(e);
      if (zone) this.lastMovementG.set(zone, now);
    } else if (e.EventClass === EventClass.CarbonMonoxide) {
      this.reading(String(e.ZoneName ?? ""), Number(e.CarbonMonoxideLevel) || 0, String(e.DangerLevel ?? ""), now);
    } else if (e.EventClass === EventClass.Penalty && /co gas|carbon monoxide/i.test(String(e.Reason ?? ""))) {
      const air = this.air(String(e.ComponentName ?? ""));
      if (!air.forced) this.engine.note("error", `${e.ComponentName}: CO penalty - exhaust fans on until the air is clean`);
      air.forced = true;
      air.want = true;
      this.nextPollG = 0; // measure again right away
    }
  }

  async onTick(now: number): Promise<void> {
    const { engine } = this;
    const dtH = this.lastTickG === null ? 0 : Math.max(0, now - this.lastTickG) / 3600;
    this.lastTickG = now;
    for (const fan of engine.components.all("fan")) if (fan.on && dtH) engine.components.addUsage("fan", fan.name, dtH);
    if (engine.replaying || !engine.cfg.fanControl) return;
    if (now >= this.nextPollG && this.worthMeasuring(now)) await this.poll(now);
    for (const fan of engine.components.all("fan")) {
      const want = this.zones.get(fan.zone)?.want ?? false;
      if (fan.on === want || !engine.components.usable("fan", fan.name)) continue;
      const ok = await engine.cmd(want ? "fan-on" : "fan-off", () => want ? engine.sim.fanOn(fan.name) : engine.sim.fanOff(fan.name), [fan.name]);
      if (ok) engine.components.setOn("fan", fan.name, want);
    }
  }

  snapshot() {
    const fans = this.engine.components.all("fan");
    return {
      polls: this.polls,
      zones: [...new Set(fans.map((f) => f.zone))].sort().map((zone) => {
        const air = this.zones.get(zone);
        return {
          zone,
          fans_on: fans.filter((f) => f.zone === zone && f.on).length,
          fans: fans.filter((f) => f.zone === zone).length,
          co: air?.level ?? null,
          risk: air?.risk ?? null,
          forced: air?.forced ?? false,
          want: air?.want ?? false,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  private async poll(now: number) {
    this.nextPollG = now + this.engine.cfg.coPollGameS;
    try {
      const zones = await this.engine.sim.listZones();
      this.polls++;
      for (const z of zones ?? []) this.reading(z.name, Number(z.gasCarbonMonoxideLevel) || 0, String(z.risk ?? ""), now);
    } catch (err) {
      if (!this.pollWarned) this.engine.note("warn", `cannot read CO levels (list-zones): ${(err as Error).message}`);
      this.pollWarned = true;
    }
  }

  /** CO only rises while cars move; a running fan must be switched off once the air is clean. */
  private worthMeasuring(now: number): boolean {
    const recentTraffic = [...this.lastMovementG.values()].some((t) => now - t < this.engine.cfg.coPollGameS * 2);
    const fanRunning = this.engine.components.all("fan").some((f) => f.on);
    return recentTraffic || fanRunning || [...this.zones.values()].some((z) => z.forced);
  }

  private reading(zone: string, level: number, risk: string, now: number) {
    if (!zone) return;
    const air = this.air(zone), { coFanOnLevel, coFanOffLevel } = this.engine.cfg;
    air.level = level;
    air.risk = risk;
    air.atG = now;
    if (level < coFanOffLevel) air.forced = false;
    const want = air.forced || level >= coFanOnLevel || (air.want && level >= coFanOffLevel);
    if (want !== air.want) this.engine.note("info", `${zone}: CO ${level.toFixed(0)} - exhaust fans ${want ? "on" : "off"}`);
    air.want = want;
  }

  private air(zone: string): ZoneAir {
    let air = this.zones.get(zone);
    if (!air) this.zones.set(zone, (air = { level: null, risk: "", atG: null, forced: false, want: false }));
    return air;
  }

  /** The zone a car is moving in: its parking spot's zone, or the zone of its entry/exit lane. */
  private zoneOfCarEvent(e: EventRecord): string | null {
    const name = String(e.SpotName ?? "");
    const spot = this.engine.spots.get(name);
    if (spot?.purpose === SpotPurpose.Park) return spot.zone || null;
    const lane = this.engine.entryLanes.get(name) ?? this.engine.exitLanes.get(name);
    return lane?.zone || spot?.zone || null;
  }
}
