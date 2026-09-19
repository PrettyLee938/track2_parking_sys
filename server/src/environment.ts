/**
 * Environment (Level 2): exhaust fans against carbon monoxide. (Lights: next, same place.)
 *
 * CO is produced in a zone only while cars move in it, and the simulator does not warn
 * first: in the 2026-09-20 03:12 run no carbon_monoxide_event ever arrived - just "High CO
 * gas level detected" penalties for ZONE1, 30 each, every ~35 s (240 in 5 minutes). And
 * list-zones costs money per call. So fans follow traffic:
 *   - a zone is busy while cars move in it (entering, parking, leaving) and for
 *     fanIdleOffGameS after the last movement: its fans run
 *   - a CO event at or above coFanThreshold, or a CO penalty, keeps them running at least
 *     coAlertHoldGameS
 *   - otherwise they are switched off (they cost electricity)
 * Only fans that are neither broken nor under repair are ever switched (operating them
 * then is a penalty). Running time is reported to the component registry as usage (game
 * hours), which is what preventive maintenance learns a fan's limit from.
 */
import { EventClass, SpotPurpose } from "@gpa/shared";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";

export class Environment implements Subsystem {
  readonly name = "environment";
  private lastMovementG = new Map<string, number>(); // zone -> game time of the last car movement
  private alertUntilG = new Map<string, number>();   // zone -> CO alert active until
  private lastCo = new Map<string, { level: number; danger: string; at: string }>();
  private lastTickG: number | null = null;

  constructor(private readonly engine: Engine) {}

  onEvent(e: EventRecord): void {
    const now = this.engine.clock.now();
    if (e.EventClass === EventClass.CarSpotAction) {
      const zone = this.zoneOfCarEvent(e);
      if (zone) this.lastMovementG.set(zone, now);
    } else if (e.EventClass === EventClass.CarbonMonoxide) {
      const zone = String(e.ZoneName ?? ""), level = Number(e.CarbonMonoxideLevel) || 0;
      this.lastCo.set(zone, { level, danger: String(e.DangerLevel ?? ""), at: e._received_at });
      if (level >= this.engine.cfg.coFanThreshold) this.alert(zone, now, `CO ${level.toFixed(0)} (${e.DangerLevel})`);
    } else if (e.EventClass === EventClass.Penalty && /co gas|carbon monoxide/i.test(String(e.Reason ?? ""))) {
      this.alert(String(e.ComponentName ?? ""), now, "CO penalty");
    }
  }

  async onTick(now: number): Promise<void> {
    const { engine } = this;
    const dtH = this.lastTickG === null ? 0 : Math.max(0, now - this.lastTickG) / 3600;
    this.lastTickG = now;
    for (const fan of engine.components.all("fan")) {
      if (fan.on && dtH) engine.components.addUsage("fan", fan.name, dtH);
    }
    if (engine.replaying || !engine.cfg.fanControl) return;
    for (const fan of engine.components.all("fan")) {
      const want = this.wanted(fan.zone, now);
      if (fan.on === want || !engine.components.usable("fan", fan.name)) continue;
      const ok = await engine.cmd(want ? "fan-on" : "fan-off", () => want ? engine.sim.fanOn(fan.name) : engine.sim.fanOff(fan.name), [fan.name]);
      if (ok) engine.components.setOn("fan", fan.name, want);
    }
  }

  snapshot() {
    const now = this.engine.clock.now();
    const zones = new Set([...this.engine.components.all("fan").map((f) => f.zone)]);
    return {
      zones: [...zones].sort().map((zone) => ({
        zone,
        fans_on: this.engine.components.all("fan").filter((f) => f.zone === zone && f.on).length,
        fans: this.engine.components.all("fan").filter((f) => f.zone === zone).length,
        busy: this.busy(zone, now),
        co_alert: (this.alertUntilG.get(zone) ?? -Infinity) > now,
        last_co: this.lastCo.get(zone) ?? null,
      })),
    };
  }

  private wanted(zone: string, now: number): boolean {
    return this.busy(zone, now) || (this.alertUntilG.get(zone) ?? -Infinity) > now;
  }

  private busy(zone: string, now: number): boolean {
    return now - (this.lastMovementG.get(zone) ?? -Infinity) < this.engine.cfg.fanIdleOffGameS;
  }

  private alert(zone: string, now: number, why: string) {
    if (!zone) return;
    const was = (this.alertUntilG.get(zone) ?? -Infinity) > now;
    this.alertUntilG.set(zone, now + this.engine.cfg.coAlertHoldGameS);
    if (!was) this.engine.note("warn", `${zone}: ${why} - exhaust fans on`);
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
