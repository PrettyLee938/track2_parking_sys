/**
 * Component health (Level 2): every gate, parking spot, exhaust fan and light, what state
 * it is in, how much it has worked, and repairs.
 *
 *   - broken / fixed webhooks are recorded (table component_events) and shown on the
 *     dashboard; usage is persisted (table components) so it survives restarts
 *   - a broken part is repaired as soon as nothing is using it: operating or repairing a
 *     part in use is a penalty, and so is operating one that is broken or under repair
 *     (the controller never sends cars to, or opens, a part that is not ok)
 *   - usage per part: gate cycles, spot visits; fans and lights report on-time through
 *     addUsage(). uses_at_breakdown is what preventive maintenance learns the limit from.
 *
 * Gates and spots keep their broken/maintenance flags on the controller's Gate/Spot
 * objects (the rest of the engine reads them there); fans and lights keep them here.
 *
 * 2026-09-20 Level 2 run: gate1 broke one minute in and nothing repaired it - the only
 * entrance stayed shut for the remaining 12 minutes.
 */
import {
  ComponentType, Direction, EventClass, GateState, SpotPurpose,
  type ComponentEventKind, type ComponentHealth, type ComponentKind, type ComponentView,
} from "@gpa/shared";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";

interface Part {
  kind: ComponentKind;
  name: string;
  zone: string;
  group: string | null;        // lights
  broken: boolean;             // fans/lights only (gates/spots: on the engine's objects)
  maintenance: boolean;
  on: boolean | null;          // fans/lights
  uses: number;                // since the last repair
  usesTotal: number;
  breakdowns: number;
  usesAtBreakdown: number[];
  lastBrokenAt: string | null;
  lastFixedAt: string | null;
  retryAfterG: number;         // game clock: no repair attempt before this
  waiting: string | null;
  dirty: boolean;              // usage changed, not yet saved
}

const KIND_OF_TYPE: Record<string, ComponentKind> = {
  [ComponentType.BarrierGate]: "gate",
  [ComponentType.ParkingSpot]: "spot",
  [ComponentType.ExhaustFan]: "fan",
  [ComponentType.Light]: "light",
};

const key = (kind: ComponentKind, name: string) => `${kind}:${name}`;

export class ComponentRegistry implements Subsystem {
  readonly name = "components";
  private parts = new Map<string, Part>();
  private listWarned = false;

  constructor(private readonly engine: Engine) {}

  // ---------------------------------------------------------------------------
  // queries (other subsystems and the dashboard)
  // ---------------------------------------------------------------------------
  get(kind: ComponentKind, name: string): Part | undefined {
    return this.parts.get(key(kind, name));
  }

  all(kind?: ComponentKind): Part[] {
    return [...this.parts.values()].filter((p) => !kind || p.kind === kind);
  }

  health(p: Part): ComponentHealth {
    const flags = p.kind === "gate" ? this.engine.gates.get(p.name) : p.kind === "spot" ? this.engine.spots.get(p.name) : p;
    if (!flags) return "ok";
    return flags.maintenance ? "maintenance" : flags.broken ? "broken" : "ok";
  }

  /** Safe to operate: not broken and not under repair (anything else is a penalty). */
  usable(kind: ComponentKind, name: string): boolean {
    const p = this.get(kind, name);
    return !!p && this.health(p) === "ok";
  }

  views(): ComponentView[] {
    const order: ComponentKind[] = ["gate", "spot", "fan", "light"];
    return [...this.parts.values()]
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((p) => ({
        kind: p.kind, name: p.name, zone: p.zone, health: this.health(p), on: this.isOn(p),
        uses: Math.round(p.uses * 100) / 100, uses_total: Math.round(p.usesTotal * 100) / 100,
        breakdowns: p.breakdowns, uses_at_breakdown: p.usesAtBreakdown,
        last_broken_at: p.lastBrokenAt, last_fixed_at: p.lastFixedAt, waiting: p.waiting,
      }));
  }

  // ---------------------------------------------------------------------------
  // updates from other subsystems (e.g. the environment switching fans and lights)
  // ---------------------------------------------------------------------------
  setOn(kind: ComponentKind, name: string, on: boolean): void {
    const p = this.get(kind, name);
    if (p) p.on = on;
  }

  /** Work done, in the part's own unit (fan/light: game hours switched on). */
  addUsage(kind: ComponentKind, name: string, amount: number): void {
    const p = this.get(kind, name);
    if (!p || this.engine.replaying) return;
    p.uses += amount;
    p.usesTotal += amount;
    p.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // subsystem hooks
  // ---------------------------------------------------------------------------
  async onSync(): Promise<void> {
    const { engine } = this;
    const seen = new Set<string>();
    const add = (kind: ComponentKind, name: string, zone: string, extra: Partial<Part> = {}) => {
      const k = key(kind, name);
      seen.add(k);
      const p = this.parts.get(k) ?? this.load(kind, name, zone);
      Object.assign(p, { zone }, extra);
      this.parts.set(k, p);
    };
    for (const g of engine.gates.values()) add("gate", g.name, g.zone);
    for (const s of engine.spots.values()) if (s.purpose === SpotPurpose.Park) add("spot", s.name, s.zone);
    try {
      const [fans, lights] = await Promise.all([engine.sim.listExhaustFans(), engine.sim.listLights()]);
      for (const f of fans ?? []) add("fan", f.name, f.zoneParent ?? "", { broken: !!f.broken, maintenance: !!f.isUnderMaintenance, on: !!f.isOn });
      for (const l of lights ?? []) add("light", l.name, l.zoneParent ?? "", { group: l.group ?? null, on: !!l.isOn });
    } catch (err) {
      // Level 1 has no fans or lights; keep going with gates and spots.
      if (!this.listWarned) engine.note("warn", `could not list fans/lights: ${(err as Error).message}`);
      this.listWarned = true;
    }
    for (const k of [...this.parts.keys()]) if (!seen.has(k)) this.parts.delete(k); // another level
    await this.repairWhatWeCan();
  }

  async onEvent(e: EventRecord): Promise<void> {
    switch (e.EventClass) {
      case EventClass.ComponentBroken: return this.onBroken(e);
      case EventClass.ComponentFixed: return this.onFixed(e);
      case EventClass.GateAction:
        if (e.Action === GateState.Open) this.used("gate", String(e.Name));
        return;
      case EventClass.CarSpotAction:
        if (e.SpotType === SpotPurpose.Park && e.Direction === Direction.In) this.used("spot", String(e.SpotName));
        return;
    }
  }

  async onTick(): Promise<void> {
    await this.repairWhatWeCan();
    for (const p of this.parts.values()) if (p.dirty) this.save(p);
  }

  // ---------------------------------------------------------------------------
  // breakdowns and repairs
  // ---------------------------------------------------------------------------
  private async onBroken(e: EventRecord) {
    const p = this.partOf(e);
    if (!p) return;
    if (p.kind === "fan" || p.kind === "light") {
      p.broken = true;
      p.on = false; // a broken fan does not run - and switching it is a penalty
    }
    if (this.engine.replaying) return; // counted and recorded the first time round
    p.breakdowns++;
    p.usesAtBreakdown.push(Math.round(p.uses * 100) / 100);
    p.lastBrokenAt = e.ServerDateTime ?? new Date().toISOString();
    this.save(p);
    this.record(p, "broken", Number(e.FineAmount) || null, `after ${Math.round(p.uses * 100) / 100} uses since the last repair`);
    this.engine.note("error", `${p.kind} ${p.name} BROKEN after ${Math.round(p.uses)} uses (fine ${e.FineAmount ?? "?"})`);
    await this.tryRepair(p);
  }

  private async onFixed(e: EventRecord) {
    const p = this.partOf(e);
    if (!p) return;
    if (p.kind === "fan" || p.kind === "light") p.broken = p.maintenance = false;
    p.waiting = null;
    p.retryAfterG = 0;
    if (this.engine.replaying) return;
    p.uses = 0; // counted again from this repair
    p.lastFixedAt = e.ServerDateTime ?? new Date().toISOString();
    this.save(p);
    this.record(p, "fixed", Number(e.RepairCost) || null, null);
    await this.engine.resume();
  }

  /** Repair every broken part nobody is using; the rest wait (reason in `waiting`). */
  async repairWhatWeCan(): Promise<void> {
    for (const p of this.parts.values()) if (this.health(p) === "broken") await this.tryRepair(p);
  }

  private async tryRepair(p: Part) {
    const { engine } = this;
    if (!engine.cfg.autoRepair || engine.replaying || this.health(p) !== "broken") return;
    const now = engine.clock.now();
    if (now < p.retryAfterG) return;
    p.waiting = this.inUse(p);
    if (p.waiting) return;
    const send = this.repairCommand(p);
    if (!send) {
      p.waiting = "the simulator has no repair command for it";
      return;
    }
    if (await engine.cmd("repair", send, [p.name])) {
      this.markMaintenance(p);
      this.record(p, "repair_sent", null, "automatic, as soon as it was free");
      engine.note("warn", `repairing broken ${p.kind} ${p.name}`);
    } else {
      p.retryAfterG = now + engine.cfg.repairRetryGameS;
      this.record(p, "repair_failed", null, `retrying in ${engine.cfg.repairRetryGameS} game-s`);
    }
  }

  /** Record a repair started by someone else (an operator from the dashboard). */
  repairStarted(kind: ComponentKind, name: string, actor: string, preventive = false): void {
    const p = this.get(kind, name);
    if (!p) return;
    this.markMaintenance(p);
    this.record(p, preventive ? "preventive_repair" : "repair_sent", null, `by ${actor}`);
  }

  private markMaintenance(p: Part) {
    const target = p.kind === "gate" ? this.engine.gates.get(p.name) : p.kind === "spot" ? this.engine.spots.get(p.name) : p;
    if (target) target.maintenance = true;
    p.waiting = null;
  }

  /** Why the part cannot be repaired right now (repairing a part in use is a penalty). */
  private inUse(p: Part): string | null {
    if (p.kind === "gate") return this.engine.gateInUse(p.name);
    if (p.kind === "spot") {
      const s = this.engine.spots.get(p.name);
      if (s?.occupants.size) return `occupied by ${[...s.occupants].join(", ")}`;
      if (s?.reserved_for) return `${s.reserved_for} is on its way to it`;
    }
    return null;
  }

  private repairCommand(p: Part): (() => Promise<void>) | null {
    const { sim } = this.engine;
    switch (p.kind) {
      case "gate": return () => sim.repairGate(p.name);
      case "spot": return () => sim.repairSpot(p.name);
      case "fan": return () => sim.repairFan(p.name);
      default: return null;
    }
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  private partOf(e: EventRecord): Part | undefined {
    const kind = KIND_OF_TYPE[String(e.Type)];
    return kind ? this.get(kind, String(e.Name)) : undefined;
  }

  private used(kind: ComponentKind, name: string) {
    this.addUsage(kind, name, 1);
  }

  private load(kind: ComponentKind, name: string, zone: string): Part {
    const saved = this.engine.store.loadComponent(kind, name);
    return {
      kind, name, zone, group: null, broken: false, maintenance: false, on: null,
      uses: saved?.uses ?? 0, usesTotal: saved?.uses_total ?? 0, breakdowns: saved?.breakdowns ?? 0,
      usesAtBreakdown: saved?.uses_at_breakdown ?? [], lastBrokenAt: saved?.last_broken_at ?? null,
      lastFixedAt: saved?.last_fixed_at ?? null, retryAfterG: 0, waiting: null, dirty: false,
    };
  }

  private save(p: Part) {
    p.dirty = false;
    this.engine.store.saveComponent({
      kind: p.kind, name: p.name, zone: p.zone, uses: p.uses, uses_total: p.usesTotal, breakdowns: p.breakdowns,
      uses_at_breakdown: p.usesAtBreakdown, last_broken_at: p.lastBrokenAt, last_fixed_at: p.lastFixedAt,
    });
  }

  private record(p: Part, event: ComponentEventKind, amount: number | null, detail: string | null) {
    this.engine.store.recordComponentEvent({ at: new Date().toISOString(), kind: p.kind, name: p.name, zone: p.zone, event, amount, detail });
  }

  private isOn(p: Part): boolean | null {
    if (p.kind === "gate") {
      const state = this.engine.gates.get(p.name)?.state;
      return state ? state === GateState.Open || state === GateState.Opening : null;
    }
    if (p.kind === "spot") return (this.engine.spots.get(p.name)?.occupants.size ?? 0) > 0;
    return p.on;
  }
}
