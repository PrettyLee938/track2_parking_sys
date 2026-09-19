/**
 * Level 2 zone environment controller.
 *
 * CO events are sparse (the simulator normally emits Mid and above only), so silence
 * never proves recovery. A high episode turns on healthy fans and restricts new
 * admissions. After one calibrated ventilation interval this subsystem makes one
 * list-zones query for fresh evidence, then either clears the restriction or leaves
 * the episode open for an operator. Lights are driven from the moving-vehicle set,
 * not from a single car, so concurrent passages cannot switch each other off.
 */
import { Direction, EventClass, SpotPurpose, type EnvironmentSnapshot, type EnvironmentZoneView } from "@gpa/shared";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";

interface ZoneState {
  zone: string;
  co: number | null;
  risk: string | null;
  freshAt: string | null;
  sourceEventId: string | null;
  restricted: boolean;
  ventilation: EnvironmentZoneView["ventilation"];
  moving: Set<string>;
  nighttime: boolean | null;
  startedG: number | null;
  recoveryDueG: number | null;
  recoveryRequested: boolean;
}

const level = (risk: string | null, co: number | null, on: number) =>
  (co ?? 0) >= on || ["mid", "high", "critical"].includes((risk ?? "").toLowerCase());
const restrictedLevel = (risk: string | null, co: number | null, on: number) =>
  (co ?? 0) >= on || ["high", "critical"].includes((risk ?? "").toLowerCase());

export class EnvironmentSubsystem implements Subsystem {
  readonly name = "environment";
  private readonly zones = new Map<string, ZoneState>();
  private calendarTime: string | null = null;
  private calendarSource: EnvironmentSnapshot["calendar_source"] = "unknown";
  private calendarConfidence: EnvironmentSnapshot["calendar_confidence"] = "unknown";
  private calendarMillis: number | null = null;
  private calendarAnchorGame = 0;
  private readonly incidentKeys = new Set<string>();
  private readonly lightEpoch = new Map<string, number>();
  private readonly lightOffScheduled = new Set<string>();
  private readonly lastMovementMillis = new Map<string, number>();
  private readonly preprocessedMovement = new Set<string>();

  constructor(private readonly engine: Engine) {}

  async onSync(): Promise<void> {
    const names = new Set<string>();
    for (const s of this.engine.spots.values()) if (s.zone) names.add(s.zone);
    try {
      const readings = await this.engine.sim.listZones();
      for (const r of readings ?? []) {
        names.add(r.name);
        const z = this.zone(r.name);
        z.co = Number.isFinite(Number(r.gasCarbonMonoxideLevel)) ? Number(r.gasCarbonMonoxideLevel) : null;
        z.risk = r.risk ?? null;
        z.freshAt = new Date().toISOString();
        z.sourceEventId = null;
        z.restricted = restrictedLevel(z.risk, z.co, this.engine.cfg.carbonMonoxideOn);
        z.ventilation = z.restricted ? "running" : "off";
      }
    } catch (err) {
      // Level 1 does not expose zones. Environment remains empty and does not block cars.
      this.engine.note("warn", `could not list zones for environment state: ${(err as Error).message}`);
    }
    for (const name of names) this.zone(name);
    await this.applyAllActiveEpisodes();
    if (this.calendarMillis === null) this.setSystemCalendar();
    else this.refreshCalendar(this.engine.clock.now());
    // A sync is a reconciliation point: simulator state may have changed while
    // the controller was stopped, so never leave a stale light state unreviewed.
    await this.syncLights();
  }

  async onEvent(e: EventRecord): Promise<void> {
    if (e.ServerDateTime) this.setCalendar(e.ServerDateTime);
    if (e.EventClass === EventClass.CarSpotAction) {
      const id = e.EventId ? String(e.EventId) : null;
      if (!id || !this.preprocessedMovement.delete(id)) this.movement(e);
    }
    if (e.EventClass === EventClass.CarbonMonoxide) await this.coEvent(e);
    if (e.EventClass === EventClass.ComponentBroken || e.EventClass === EventClass.ComponentFixed) {
      const kind = String(e.Type ?? "").toLowerCase();
      if (kind.includes("fan")) await this.applyAllActiveEpisodes();
    }
    await this.syncLights();
  }

  async onBeforeEvent(e: EventRecord): Promise<void> {
    if (e.ServerDateTime) this.setCalendar(e.ServerDateTime);
    if (e.EventClass === EventClass.CarSpotAction && this.startsMovement(e)) {
      this.movement(e);
      if (e.EventId) this.preprocessedMovement.add(String(e.EventId));
    }
    // In particular, this runs before the controller opens an entry gate or sends
    // the car to its spot, so nighttime guidance is already active during dispatch.
    await this.syncLights();
  }

  async onTick(gameNow: number): Promise<void> {
    this.refreshCalendar(gameNow);
    const due = [...this.zones.values()].filter((z) => z.recoveryDueG !== null && gameNow >= z.recoveryDueG && !z.recoveryRequested);
    if (due.length) await this.verifyRecovery(due, gameNow);
    await this.syncLights();
  }

  isZoneRestricted(zone: string): boolean {
    return !!zone && this.zone(zone).restricted;
  }

  snapshot(): EnvironmentSnapshot {
    return {
      calendar_time: this.calendarTime,
      calendar_source: this.calendarSource,
      calendar_confidence: this.calendarConfidence,
      zones: [...this.zones.values()].sort((a, b) => a.zone.localeCompare(b.zone)).map((z) => ({
        zone: z.zone, co: z.co, risk: z.risk, fresh_at: z.freshAt, source_event_id: z.sourceEventId, restricted: z.restricted,
        ventilation: z.ventilation, moving: z.moving.size, nighttime: z.nighttime,
      })),
    };
  }

  private zone(name: string): ZoneState {
    return this.zones.get(name) ?? (() => {
      const z: ZoneState = { zone: name, co: null, risk: null, freshAt: null, sourceEventId: null, restricted: false, ventilation: "unknown",
        moving: new Set(), nighttime: null, startedG: null, recoveryDueG: null, recoveryRequested: false };
      if (this.calendarMillis !== null) z.nighttime = this.isNight(new Date(this.calendarMillis +
        Math.max(0, this.engine.clock.now() - this.calendarAnchorGame) * 1000));
      this.zones.set(name, z);
      return z;
    })();
  }

  private setCalendar(raw: string): void {
    const parsed = new Date(raw.replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) return;
    // Delivery order is not guaranteed.  A delayed webhook must not make a
    // current night look like daytime (or vice versa).  The initial system-clock
    // fallback is provisional, so the first simulator timestamp always replaces it.
    if (this.calendarSource === "event_timestamp" && this.calendarMillis !== null && parsed.getTime() < this.calendarMillis) return;
    this.calendarTime = raw;
    this.calendarSource = "event_timestamp";
    this.calendarConfidence = "provisional";
    this.calendarMillis = parsed.getTime();
    this.calendarAnchorGame = this.engine.clock.now();
    this.applyNighttime(this.calendarMillis);
  }

  /** Use local wall time only until the simulator gives us its own timestamp. */
  private setSystemCalendar(): void {
    const now = new Date();
    this.calendarMillis = now.getTime();
    this.calendarAnchorGame = this.engine.clock.now();
    this.calendarTime = this.formatCalendar(now);
    this.calendarSource = "system_clock";
    this.calendarConfidence = "provisional";
    this.applyNighttime(this.calendarMillis);
  }

  /** Advance simulator wall time with game time, including configured speed and pauses. */
  private refreshCalendar(gameNow: number): void {
    if (this.calendarMillis === null) return;
    const projected = this.calendarMillis + Math.max(0, gameNow - this.calendarAnchorGame) * 1000;
    this.calendarTime = this.formatCalendar(new Date(projected));
    this.applyNighttime(projected);
  }

  private formatCalendar(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  private isNight(date: Date): boolean {
    const hour = date.getHours();
    return this.engine.cfg.nightStartHour > this.engine.cfg.nightEndHour
      ? hour >= this.engine.cfg.nightStartHour || hour < this.engine.cfg.nightEndHour
      : hour >= this.engine.cfg.nightStartHour && hour < this.engine.cfg.nightEndHour;
  }

  private applyNighttime(calendarMillis: number): void {
    const night = this.isNight(new Date(calendarMillis));
    let changed = false;
    for (const z of this.zones.values()) {
      if (z.nighttime !== night) changed = true;
      z.nighttime = night;
    }
    if (changed) this.engine.note("info", `light policy: ${night ? "night" : "day"}`);
  }

  private movement(e: EventRecord): void {
    const plate = String(e.CarPlateNumber ?? "");
    if (!plate) return;
    const eventMillis = e.ServerDateTime ? new Date(String(e.ServerDateTime).replace(" ", "T")).getTime() : Number.NaN;
    const previousMillis = this.lastMovementMillis.get(plate);
    if (Number.isFinite(eventMillis) && previousMillis !== undefined && eventMillis < previousMillis) return;
    if (Number.isFinite(eventMillis)) this.lastMovementMillis.set(plate, eventMillis);
    const name = String(e.SpotName ?? "");
    const direction = String(e.Direction ?? "");
    let zone = "";
    if (e.SpotType === SpotPurpose.Entry) zone = this.engine.entryLanes.get(name)?.zone ?? "";
    else if (e.SpotType === SpotPurpose.Exit) zone = this.engine.exitLanes.get(name)?.zone ?? "";
    else zone = this.engine.spots.get(name)?.zone ?? "";
    if (!zone) return;
    for (const z of this.zones.values()) z.moving.delete(plate);
    const target = this.zone(zone);
    if ((e.SpotType === SpotPurpose.Entry && direction === Direction.In) ||
      (e.SpotType === SpotPurpose.Park && direction === Direction.Out) ||
      (e.SpotType === SpotPurpose.Exit && direction === Direction.In)) target.moving.add(plate);
    if (e.SpotType === SpotPurpose.Exit && direction === Direction.Out) target.moving.delete(plate);
    if (e.SpotType === SpotPurpose.Park && direction === Direction.In) target.moving.delete(plate);
  }

  private startsMovement(e: EventRecord): boolean {
    return (e.SpotType === SpotPurpose.Entry && e.Direction === Direction.In) ||
      (e.SpotType === SpotPurpose.Park && e.Direction === Direction.Out) ||
      (e.SpotType === SpotPurpose.Exit && e.Direction === Direction.In);
  }

  private async coEvent(e: EventRecord): Promise<void> {
    const name = String(e.ZoneName ?? "");
    if (!name) return;
    const z = this.zone(name);
    z.co = Number.isFinite(Number(e.CarbonMonoxideLevel)) ? Number(e.CarbonMonoxideLevel) : null;
    z.risk = e.DangerLevel ? String(e.DangerLevel) : z.risk;
    z.freshAt = e.ServerDateTime ? String(e.ServerDateTime) : new Date().toISOString();
    z.sourceEventId = e.EventId ? String(e.EventId) : null;
    if (level(z.risk, z.co, this.engine.cfg.carbonMonoxideOn)) {
      z.restricted = ["high", "critical"].includes((z.risk ?? "").toLowerCase()) || (z.co ?? 0) >= this.engine.cfg.carbonMonoxideOn;
      z.ventilation = "running";
      z.recoveryRequested = false;
      z.recoveryDueG = this.engine.clock.now() + this.engine.cfg.ventilationMinGameS;
      z.startedG ??= this.engine.clock.now();
      await this.startFans(z);
    }
  }

  private async applyAllActiveEpisodes(): Promise<void> {
    for (const z of this.zones.values()) if (level(z.risk, z.co, this.engine.cfg.carbonMonoxideOn)) {
      z.startedG ??= this.engine.clock.now();
      z.recoveryDueG ??= this.engine.clock.now() + this.engine.cfg.ventilationMinGameS;
      await this.startFans(z);
    }
  }

  private async startFans(z: ZoneState): Promise<void> {
    const fans = this.engine.components.all("fan").filter((p) => p.zone === z.zone);
    const usable = fans.filter((p) => this.engine.components.usable("fan", p.name));
    if (!usable.length) {
      const key = `fan-unavailable:${z.zone}`;
      if (!this.incidentKeys.has(key)) {
        this.incidentKeys.add(key);
        this.engine.store.createIncident({ status: "open", kind: "co_fan_unavailable", zone: z.zone,
          reason: "CO is elevated but no healthy exhaust fan is available", confidence: "high", evidence: { co: z.co, risk: z.risk } });
      }
      z.restricted = true;
      z.ventilation = "unknown";
      return;
    }
    for (const fan of usable) {
      if (fan.on === true) continue;
      if (await this.engine.cmd("fan-on", () => this.engine.sim.fanOn(fan.name), [fan.name])) {
        this.engine.components.setOn("fan", fan.name, true);
      }
    }
    z.ventilation = "running";
    z.startedG ??= this.engine.clock.now();
  }

  private async verifyRecovery(zones: ZoneState[], gameNow: number): Promise<void> {
    for (const z of zones) z.recoveryRequested = true;
    let readings;
    try {
      readings = await this.engine.sim.listZones();
    } catch (err) {
      for (const z of zones) {
        z.ventilation = "recovery_pending";
        this.engine.store.createIncident({ status: "open", kind: "co_recovery_unknown", zone: z.zone,
          reason: `CO recovery query failed: ${(err as Error).message}`, confidence: "low", evidence: {} });
      }
      return;
    }
    for (const z of zones) {
      const r = (readings ?? []).find((x) => x.name === z.zone);
      const co = r ? Number(r.gasCarbonMonoxideLevel) : null;
      const safe = !!r && co !== null && Number.isFinite(co) && co < this.engine.cfg.carbonMonoxideOff && String(r.risk).toLowerCase() === "safe";
      if (!safe || z.startedG === null || gameNow - z.startedG < this.engine.cfg.ventilationRecoveryGameS) {
        z.ventilation = "recovery_pending";
        this.engine.store.createIncident({ status: "open", kind: "co_recovery_unknown", zone: z.zone,
          reason: "fresh safe CO evidence was not available after ventilation", confidence: "medium", evidence: { reading: r ?? null } });
        continue;
      }
      for (const fan of this.engine.components.all("fan").filter((p) => p.zone === z.zone && this.engine.components.usable("fan", p.name))) {
        if (fan.on !== true) continue;
        if (await this.engine.cmd("fan-off", () => this.engine.sim.fanOff(fan.name), [fan.name])) this.engine.components.setOn("fan", fan.name, false);
      }
      z.co = co!; z.risk = r.risk; z.freshAt = new Date().toISOString(); z.restricted = false;
      z.ventilation = "off"; z.startedG = null; z.recoveryDueG = null;
    }
  }

  private async syncLights(): Promise<void> {
    const lights = this.engine.components.all("light");
    if (!lights.length) return;
    const immediate: Array<{ light: typeof lights[number]; on: boolean }> = [];

    for (const light of lights) {
      const zone = this.zone(light.zone);
      const wantOn = zone.nighttime === true && zone.moving.size > 0;
      if (wantOn) {
        this.cancelLightOff(light.name);
        if (this.engine.components.usable("light", light.name) && light.on !== true) immediate.push({ light, on: true });
        continue;
      }

      if (light.on !== true || !this.engine.components.usable("light", light.name)) {
        this.cancelLightOff(light.name);
        continue;
      }

      // At night, wait for a short clearance interval so a second vehicle can
      // arrive without flickering the guide lights.  In daytime (and while the
      // calendar is unknown), switch off immediately: lights must not run then.
      if (zone.nighttime === true) this.scheduleLightOff(light);
      else {
        this.cancelLightOff(light.name);
        immediate.push({ light, on: false });
      }
    }

    await this.applyLightChanges(immediate);
  }

  private cancelLightOff(name: string): void {
    if (!this.lightOffScheduled.delete(name)) return;
    this.lightEpoch.set(name, (this.lightEpoch.get(name) ?? 0) + 1);
  }

  private scheduleLightOff(light: ReturnType<Engine["components"]["all"]>[number]): void {
    if (this.lightOffScheduled.has(light.name)) return;
    const epoch = (this.lightEpoch.get(light.name) ?? 0) + 1;
    this.lightEpoch.set(light.name, epoch);
    this.lightOffScheduled.add(light.name);
    this.engine.later(this.engine.cfg.lightClearanceGameS, `light off ${light.name}`, async () => {
      this.lightOffScheduled.delete(light.name);
      const current = this.engine.components.get("light", light.name);
      if (!current || this.lightEpoch.get(light.name) !== epoch) return;
      const zone = this.zone(current.zone);
      if (zone.nighttime === true && zone.moving.size > 0) return;
      if (!this.engine.components.usable("light", current.name) || current.on !== true) return;
      await this.applyLightChanges([{ light: current, on: false }]);
    });
  }

  private async applyLightChanges(changes: Array<{ light: ReturnType<Engine["components"]["all"]>[number]; on: boolean }>): Promise<void> {
    const pending = changes.filter(({ light, on }) => this.engine.components.usable("light", light.name) && light.on !== on);
    if (!pending.length) return;

    const byGroup = new Map<string, typeof pending>();
    for (const change of pending) {
      const group = change.light.group || change.light.name;
      const list = byGroup.get(group) ?? [];
      list.push(change);
      byGroup.set(group, list);
    }

    for (const [group, groupChanges] of byGroup) {
      const target = groupChanges[0].on;
      const groupLights = this.engine.components.all("light").filter((p) => (p.group || p.name) === group);
      const canUseGroup = groupLights.length > 1 && groupLights.length === groupChanges.length &&
        groupChanges.every((change) => change.on === target) &&
        groupLights.every((p) => this.engine.components.usable("light", p.name) && p.on !== target);
      if (canUseGroup && await this.engine.cmd(target ? "light-group-on" : "light-group-off",
        () => target ? this.engine.sim.lightGroupOn(group) : this.engine.sim.lightGroupOff(group), [group])) {
        for (const light of groupLights) {
          this.engine.components.setOn("light", light.name, target);
          this.engine.note("info", `light ${light.name} ${target ? "on" : "off"} (${light.zone}, grouped ${group})`);
        }
        continue;
      }

      for (const { light, on } of groupChanges) {
        const changed = await this.engine.cmd(on ? "light-on" : "light-off",
          () => on ? this.engine.sim.lightOn(light.name) : this.engine.sim.lightOff(light.name), [light.name]);
        if (changed) {
          this.engine.components.setOn("light", light.name, on);
          this.engine.note("info", `light ${light.name} ${on ? "on" : "off"} (${light.zone})`);
        }
      }
    }
  }
}
