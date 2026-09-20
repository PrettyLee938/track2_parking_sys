/**
 * Environment (Level 2): exhaust fans against carbon monoxide, and the lights.
 *
 * LIGHTS. The spec: they guide drivers in dark zones, they cost electricity, "make sure
 * they run only at night", and "no need to be on if all cars are parking, they must be on
 * if a car is moving in the zone". So the rule is movement, not occupancy: a full car park
 * with nobody driving needs no light, and one car crossing an empty one does.
 *
 * What a moving car lights depends on lightsDetail:
 *   route (default) - only what that car uses: the middle aisle it drives along, and while
 *                     it is driving to a spot, the bay light over that spot's own row.
 *                     A car on its way out lights the aisle only - it is leaving, not
 *                     looking for a space. Needs the level file for light positions.
 *   group           - one command per zone, all ten lights together. Fewer commands, but
 *                     every light burns whenever any car moves.
 * Either way a light stays on lightsHoldGameS after the last car needed it, so a stream of
 * cars does not flicker it, and if nothing moves anywhere for lightsIdleOffGameS every
 * light is switched off regardless - a backstop for a dropped command or a car record that
 * never closed.
 *
 * "Night" is a configured window (nightStartHour..nightEndHour) read off the latest event's
 * ServerDateTime, because no event carries the simulator's time of day - ServerDateTime is
 * the wall clock. lightsMode=always ignores the clock; never leaves the lights alone.
 *
 * Only lights that are neither broken nor under repair are switched (operating them
 * otherwise is a penalty), and on-time goes to the component registry as usage in game
 * hours - the same way fans are measured, and what preventive maintenance learns from.
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
import { EventClass, SpotPurpose, type CarStatus, type ComponentKind, type ControlResult, type DeviceHoldView } from "@gpa/shared";
import type { Car } from "./controller";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";
import { nearestLight, placementFromLevelsDir, type SitePlacement } from "./topology";

interface ZoneAir {
  level: number | null;   // latest CO reading
  risk: string;
  atG: number | null;     // game clock of that reading
  forced: boolean;        // a CO penalty: fans on until a reading below coFanOffLevel
  want: boolean;          // fans should run
}

const key = (kind: ComponentKind, name: string) => `${kind}:${name}`;
const ok = (message: string): ControlResult => ({ ok: true, message });
const fail = (message: string): ControlResult => ({ ok: false, message });

/** Which cars are driving, and so what has to be lit. */
const DRIVING_IN: ReadonlySet<CarStatus> = new Set(["dispatching", "dispatched", "entering"]);
// Reaching an exit sensor is not the same as moving: cars can wait there for an
// invoice/payment. Keep light demand tied to actual transit states so an exit
// queue does not burn every light indefinitely.
const DRIVING_OUT: ReadonlySet<CarStatus> = new Set(["to_exit"]);

export class Environment implements Subsystem {
  readonly name = "environment";
  private zones = new Map<string, ZoneAir>();
  private lastMovementG = new Map<string, number>();
  private nextPollG = 0;
  private lastTickG: number | null = null;
  private pollWarned = false;
  polls = 0;

  // ---- lights ----------------------------------------------------------------
  /** Light positions from the level file; empty when it is unavailable (then: group mode). */
  private placement: SitePlacement | undefined;
  /** Light name -> game time it may stay on until. The hold that stops flicker. */
  private readonly litUntilG = new Map<string, number>();
  private lastSimHour: number | null = null;
  private lastAnyMovementG: number | null = null;
  private lightsNote = "";
  /**
   * "kind:name" -> an operator override from the dashboard. While one is set the automatic
   * rules leave that part alone - the same contract gates have, so a manual decision is not
   * undone a tick later. "auto" clears it.
   */
  private readonly holds = new Map<string, { hold: "on" | "off"; actor: string; at: string }>();

  constructor(private readonly engine: Engine) {}

  onSync(): void {
    // The level file names every light's coordinates; list-lights does not. Without it
    // "light only this car's row" is not answerable, so route mode falls back to group.
    const { cfg, topology } = this.engine;
    if (!cfg.simLevelsDir || !topology) return;
    this.placement = placementFromLevelsDir(cfg.simLevelsDir, topology, {
      info: (m) => this.engine.note("info", m),
      error: (m) => this.engine.note("warn", m),
    });
    if (!this.placement && cfg.lightsDetail === "route") {
      this.engine.note("warn", "no light positions in the level files - lighting whole zones instead of routes");
    }
  }

  onEvent(e: EventRecord): void {
    const now = this.engine.clock.now();
    // The only clock we have: no event carries the simulator's time of day.
    const hour = /(\d{1,2}):(\d{2})/.exec(String(e.ServerDateTime ?? ""));
    if (hour) this.lastSimHour = Number(hour[1]) + Number(hour[2]) / 60;

    if (e.EventClass === EventClass.CarSpotAction) {
      const zone = this.zoneOfCarEvent(e);
      if (zone) this.lastMovementG.set(zone, now);
      this.lastAnyMovementG = now;
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
    await this.driveFans(now, dtH);
    // Lights are independent of the fans: turning fan control off must not take the
    // lighting with it, which an early return in the fan code used to do.
    await this.driveLights(now, dtH);
  }

  private async driveFans(now: number, dtH: number) {
    const { engine } = this;
    for (const fan of engine.components.all("fan")) if (fan.on && dtH) engine.components.addUsage("fan", fan.name, dtH);
    if (engine.replaying || !engine.cfg.fanControl) return;
    if (now >= this.nextPollG && this.worthMeasuring(now)) await this.poll(now);
    for (const fan of engine.components.all("fan")) {
      let want = this.zones.get(fan.zone)?.want ?? false;
      const held = this.holds.get(key("fan", fan.name));
      if (held?.hold === "off" && want) {
        // Ventilation is a safety function. An operator may keep a fan running as long as
        // they like - that only costs wear - but holding one OFF while its zone is above
        // the CO level is exactly the "High CO gas level" penalty we keep being fined for,
        // and nothing else would ever reconsider the hold. So that one is released.
        this.holds.delete(key("fan", fan.name));
        engine.note("error", `${fan.name}: releasing ${held.actor}'s hold - ${fan.zone} needs ventilation`);
      } else if (held) {
        want = held.hold === "on";
      }
      if (fan.on === want || !engine.components.usable("fan", fan.name)) continue;
      const ok = await engine.cmd(want ? "fan-on" : "fan-off", () => want ? engine.sim.fanOn(fan.name) : engine.sim.fanOff(fan.name), [fan.name]);
      if (ok) engine.components.setOn("fan", fan.name, want);
    }
  }

  /**
   * Manual control of one exhaust fan or light from the dashboard, the same way a gate is
   * held open or closed: "on"/"off" take the part out of automatic control until "auto"
   * hands it back. Anything the simulator would fine us for is refused with the reason.
   */
  async control(kind: ComponentKind, name: string, action: string, actor: string): Promise<ControlResult | null> {
    if (kind !== "fan" && kind !== "light") return null; // not ours: gates and spots stay on the controller
    if (action !== "on" && action !== "off" && action !== "auto") return null;

    const { engine } = this;
    const part = engine.components.get(kind, name);
    if (!part) return fail(`unknown ${kind} ${name}`);

    if (action === "auto") {
      if (!this.holds.delete(key(kind, name))) return ok(`${name} is already automatic`);
      engine.note("info", `${actor} returned ${kind} ${name} to automatic`);
      // The next tick puts it wherever CO or daylight wants it; say which that is now.
      return ok(`${name} back under ${kind === "fan" ? "CO" : "daylight"} control`);
    }

    const health = engine.components.health(part);
    if (health !== "ok") return fail(`${name} is ${health} - operating it now is a penalty`);
    const on = action === "on";
    if (kind === "fan" && !on && (this.zones.get(part.zone)?.want ?? false)) {
      return fail(`${part.zone} is above the CO level - ${name} must keep running`);
    }

    this.holds.set(key(kind, name), { hold: action, actor, at: new Date().toISOString() });
    if (part.on === on) return ok(`${name} is already ${action}, and is now held ${action}`);

    const send = kind === "fan"
      ? () => (on ? engine.sim.fanOn(name) : engine.sim.fanOff(name))
      : () => (on ? engine.sim.lightOn(name) : engine.sim.lightOff(name));
    if (!(await engine.cmd(`${kind}-${action}`, send, [name], actor))) {
      this.holds.delete(key(kind, name));
      return fail(`the simulator rejected ${action} ${name}`);
    }
    engine.components.setOn(kind, name, on);
    engine.note("warn", `${actor} switched ${kind} ${name} ${action}`);
    return ok(`${name} switched ${action} and held there until Automatic`);
  }

  // ---------------------------------------------------------------------------
  // lights
  // ---------------------------------------------------------------------------
  private async driveLights(now: number, dtH: number) {
    const { engine } = this;
    const lights = engine.components.all("light");
    // On-time is the usage that wears a light out, exactly as for a fan.
    for (const l of lights) if (l.on && dtH) engine.components.addUsage("light", l.name, dtH);
    if (engine.replaying || !engine.cfg.lightControl || engine.cfg.lightsMode === "never" || !lights.length) return;

    const wanted = this.wantedLights(now);
    if (wanted === null) {
      // Daytime, or the whole car park has gone quiet: off now, holds and all. Letting the
      // anti-flicker hold survive this is what stopped "nothing moved for 5 minutes" from
      // ever switching anything off.
      this.litUntilG.clear();
    } else {
      for (const name of wanted) this.litUntilG.set(name, now + engine.cfg.lightsHoldGameS);
      for (const [name, until] of this.litUntilG) if (until <= now) this.litUntilG.delete(name);
    }

    // An operator's hold beats both the automatic rules and the idle sweep above: lighting
    // is not a safety function, so a manual decision simply stands until it is handed back.
    const on = (name: string) => {
      const held = this.holds.get(key("light", name));
      return held ? held.hold === "on" : this.litUntilG.has(name);
    };
    if (engine.cfg.lightsDetail === "group" || !this.placement) {
      // One command per zone: a group is lit if anything in it is wanted.
      const groups = new Map<string, { want: boolean; names: string[] }>();
      for (const l of lights) {
        const g = groups.get(l.group ?? "") ?? { want: false, names: [] };
        g.want ||= on(l.name);
        g.names.push(l.name);
        groups.set(l.group ?? "", g);
      }
      for (const [group, g] of groups) {
        if (!group) continue;
        const usable = g.names.filter((n) => engine.components.usable("light", n));
        if (!usable.length || usable.every((n) => engine.components.get("light", n)?.on === g.want)) continue;
        // A group command operates every light in the group, including a broken one - which
        // is a penalty. With one out of service, switch the rest individually instead.
        if (usable.length < g.names.length) {
          for (const n of usable) {
            if (engine.components.get("light", n)?.on === g.want) continue;
            const one = await engine.cmd(g.want ? "light-on" : "light-off",
              () => g.want ? engine.sim.lightOn(n) : engine.sim.lightOff(n), [n]);
            if (one) engine.components.setOn("light", n, g.want);
          }
          continue;
        }
        const ok = await engine.cmd(g.want ? "light-group-on" : "light-group-off",
          () => g.want ? engine.sim.lightGroupOn(group) : engine.sim.lightGroupOff(group), [group]);
        if (ok) for (const n of usable) engine.components.setOn("light", n, g.want);
      }
      return;
    }

    for (const l of lights) {
      const want = on(l.name);
      if (l.on === want || !engine.components.usable("light", l.name)) continue;
      const ok = await engine.cmd(want ? "light-on" : "light-off",
        () => want ? engine.sim.lightOn(l.name) : engine.sim.lightOff(l.name), [l.name]);
      if (ok) engine.components.setOn("light", l.name, want);
    }
  }

  /**
   * Which lights this instant calls for, before the anti-flicker hold is applied.
   *
   * null means "off now, hold or no hold": it is daytime, or nothing has moved anywhere for
   * lightsIdleOffGameS. An empty set means nothing is moving *at the moment* - the hold may
   * still keep a light on for a few seconds, so the next car in a stream does not arrive in
   * the dark. A full car park with everyone parked reaches the empty set: occupancy is not
   * what lights ask about, movement is.
   */
  private wantedLights(now: number): Set<string> | null {
    const { engine } = this;
    const { lightsMode, lightsIdleOffGameS } = engine.cfg;

    if (lightsMode === "auto" && !this.isNight()) {
      this.lightsNote = this.lastSimHour === null ? "no event seen yet" : "daytime";
      return null;
    }
    if (lightsIdleOffGameS > 0 && this.lastAnyMovementG !== null && now - this.lastAnyMovementG >= lightsIdleOffGameS) {
      this.lightsNote = "nothing has moved in the car park";
      return null;
    }

    const want = new Set<string>();
    let movers = 0;
    for (const car of engine.cars.values()) {
      const zone = this.zoneOfMovingCar(car);
      if (!zone) continue;
      movers++;
      // A car on its way out only needs the aisle; one looking for a space also needs the
      // light over the row it is heading for.
      const toSpot = DRIVING_IN.has(car.status) ? car.spot : null;
      for (const name of this.lightsFor(zone, toSpot)) want.add(name);
    }
    this.lightsNote = movers ? `${movers} car${movers === 1 ? "" : "s"} moving` : "all cars parked";
    return want;
  }

  /** The lights a car moving in `zone` needs: its aisle, plus the bay over `toSpot`. */
  private lightsFor(zone: string, toSpot: string | null): string[] {
    const placement = this.placement;
    if (!placement) return this.engine.components.all("light").filter((l) => l.zone === zone).map((l) => l.name);

    const inZone = [...placement.lights.values()].filter((l) => l.zone === zone);
    const names = inZone.filter((l) => l.role === "road").map((l) => l.name);
    // A zone the level file gives no aisle for: light all of it rather than nothing.
    if (!names.length) return inZone.map((l) => l.name);

    const at = toSpot ? placement.spots.get(toSpot) : undefined;
    if (at) {
      const bay = nearestLight(inZone, at, "bay");
      if (bay) names.push(bay.name);
    }
    return names;
  }

  /** The zone a car is currently driving in, or null when it is not driving. */
  private zoneOfMovingCar(car: Car): string | null {
    if (DRIVING_IN.has(car.status)) {
      // Heading for a spot: the zone that spot is in.
      return (car.spot ? this.engine.spots.get(car.spot)?.zone : null) ||
        (car.entry_lane ? this.engine.entryLanes.get(car.entry_lane)?.zone : null) || null;
    }
    if (DRIVING_OUT.has(car.status)) {
      // Leaving: the zone it is driving out of, or the one its exit belongs to.
      return (car.spot ? this.engine.spots.get(car.spot)?.zone : null) ||
        (car.exit_lane ? this.engine.exitLanes.get(car.exit_lane)?.zone : null) || null;
    }
    return null;
  }

  /** Night by the configured window, read off the latest event's hour. */
  private isNight(): boolean {
    const { lightsMode, nightStartHour, nightEndHour } = this.engine.cfg;
    if (lightsMode === "always") return true;
    if (this.lastSimHour === null) return false;
    // A window that wraps midnight (18..6) is the normal case.
    return nightStartHour <= nightEndHour
      ? this.lastSimHour >= nightStartHour && this.lastSimHour < nightEndHour
      : this.lastSimHour >= nightStartHour || this.lastSimHour < nightEndHour;
  }

  snapshot() {
    const fans = this.engine.components.all("fan");
    const lights = this.engine.components.all("light");
    return {
      polls: this.polls,
      lights: {
        on: lights.filter((l) => l.on).length,
        total: lights.length,
        mode: this.engine.cfg.lightsMode,
        // What is actually in force: route needs the level file, and falls back without it.
        detail: this.placement ? this.engine.cfg.lightsDetail : "group",
        night: this.isNight(),
        hour: this.lastSimHour,
        reason: this.lightsNote,
      },
      holds: [...this.holds].map(([k, h]): DeviceHoldView => {
        const [kind, ...rest] = k.split(":");
        return { kind: kind as "fan" | "light", name: rest.join(":"), hold: h.hold, actor: h.actor, at: h.at };
      }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
      zones: [...new Set([...fans, ...lights].map((c) => c.zone))].sort().map((zone) => {
        const air = this.zones.get(zone);
        return {
          zone,
          fans_on: fans.filter((f) => f.zone === zone && f.on).length,
          fans: fans.filter((f) => f.zone === zone).length,
          lights_on: lights.filter((l) => l.zone === zone && l.on).length,
          lights: lights.filter((l) => l.zone === zone).length,
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
