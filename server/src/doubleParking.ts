/**
 * Double parking: early warning when one car takes more than one spot, or one spot holds
 * more than one car (Level 3 §7.9).
 *
 * The simulator lets a second car park in an occupied spot - it only fines us for sending
 * it there - and the spot then holds a *set* of cars. That is how one wrong decision turns
 * into a run of penalties: the first car leaves, we think the spot is free, and every car
 * sent there afterwards is fined too. So this watches for the shapes that come before
 * the fine, and says so loudly.
 *
 * Three things are detected:
 *   risk        we are about to send a car to a spot whose sensor already sees something.
 *               This is the only genuinely *early* warning: it fires before the goto.
 *   occupied    a CarIn arrived for a spot that already holds another named car, or the
 *               sensor counts two cars where two really did arrive.
 *   two_spots   one plate is recorded in two spots at once - it drove off to a second one
 *               without a CarOut, so we are holding a spot nobody is in.
 *
 * Deliberately NOT here: a sensor that counts cars nobody ever saw arrive. That is a
 * broken sensor, and sensorHealth.ts deals with it.
 *
 * This subsystem only observes: it raises incidents, feed lines and a dashboard badge.
 * It never sends a command, so it cannot itself earn a penalty. Switch it off with
 * GPA_DOUBLE_PARKING_WATCH=false.
 */
import { Direction, EventClass, SpotPurpose, type DoubleParkingSnapshot, type DoubleParkingKind } from "@gpa/shared";
import type { Spot } from "./controller";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";

interface Alert {
  kind: DoubleParkingKind;
  spot: string;
  zone: string;
  plates: string[];
  reason: string;
  neighbour: string | null;
  atG: number;
  incident: number | null;
}

export class DoubleParking implements Subsystem {
  readonly name = "double_parking";
  /** Open alerts by spot; one per spot, so a busy spot cannot flood the page. */
  private readonly alerts = new Map<string, Alert>();
  private warnings = 0;

  constructor(private readonly engine: Engine) {}

  private get on() {
    return this.engine.cfg.doubleParkingWatch && !this.engine.replaying;
  }

  /**
   * About to dispatch a car to this spot. If the sensor already sees something, say so
   * now - this is the one moment we can warn before the simulator fines us.
   */
  reserved(name: string, plate: string): void {
    if (!this.on) return;
    const spot = this.engine.spots.get(name);
    if (!spot) return;
    const others = [...spot.occupants].filter((p) => p !== plate);
    if (!spot.detected && !others.length) return;
    this.raise("risk", spot, [plate, ...others],
      `about to send ${plate} to ${name}, whose sensor already reports ${spot.detected} car(s)` +
      (others.length ? ` (${others.join(", ")})` : ""));
  }

  onEvent(e: EventRecord): void {
    if (!this.on) return;
    if (e.EventClass !== EventClass.CarSpotAction || e.SpotType !== SpotPurpose.Park) return;
    const name = String(e.SpotName ?? ""), plate = String(e.CarPlateNumber ?? "");
    const spot = this.engine.spots.get(name);
    if (!spot || !plate) return;

    if (e.Direction === Direction.Out) {
      // The spot may be clean again; drop the alert once nobody is left in it.
      if (spot.occupants.size <= 1) this.resolve(name, "the spot is no longer shared");
      return;
    }

    // The controller has already added this plate to the set by the time we see the event.
    const others = [...spot.occupants].filter((p) => p !== plate);
    if (others.length) {
      this.raise("occupied", spot, [...spot.occupants],
        `${name} now holds ${spot.occupants.size} cars: ${[...spot.occupants].join(", ")}`);
    }

    // The same plate sitting in two spots: it moved without its CarOut arriving, so one of
    // the two spots is being held for a car that is not there.
    const elsewhere = [...this.engine.spots.values()]
      .filter((s) => s.name !== name && s.occupants.has(plate))
      .map((s) => s.name);
    if (elsewhere.length) {
      this.raise("two_spots", spot, [plate],
        `${plate} is recorded in ${name} and also in ${elsewhere.join(", ")}`);
    }
  }

  /** Sensors can only be compared with what we believe on a sync. */
  onSync(): void {
    if (!this.on) return;
    for (const spot of this.engine.spots.values()) {
      if (spot.purpose !== SpotPurpose.Park) continue;
      const named = [...spot.occupants].filter((p) => p !== "?");
      // Two cars we can name, and a sensor that agrees: this is real, not a miscount.
      if (spot.detected > 1 && named.length > 1) {
        this.raise("occupied", spot, named, `sensor confirms ${spot.detected} cars in ${spot.name}: ${named.join(", ")}`);
      } else if (spot.detected <= 1 && spot.occupants.size <= 1) {
        this.resolve(spot.name, "the spot reports a single car again");
      }
    }
  }

  private raise(kind: DoubleParkingKind, spot: Spot, plates: string[], reason: string) {
    const existing = this.alerts.get(spot.name);
    // A risk warning must not overwrite a confirmed double park, but a confirmation
    // should replace the warning that preceded it.
    if (existing && (existing.kind !== "risk" || kind === "risk")) return;
    this.warnings++;
    const neighbour = this.neighbourOf(spot);
    const incident = this.engine.store.createIncident({
      status: kind === "risk" ? "provisional" : "open",
      kind: `double_parking_${kind}`, zone: spot.zone || null, component: spot.name,
      reason, confidence: kind === "risk" ? "medium" : "high",
      evidence: { spot: spot.name, zone: spot.zone, plates, detected: spot.detected, neighbour, signal: kind },
    });
    this.alerts.set(spot.name, { kind, spot: spot.name, zone: spot.zone, plates, reason, neighbour,
      atG: this.engine.clock.now(), incident: incident.id });
    this.engine.store.recordAudit({ action: `double_parking.${kind}`, target: spot.name, ok: true, reason,
      detail: { plates, neighbour, incident: incident.id } });
    this.engine.note(kind === "risk" ? "warn" : "error", `DOUBLE PARKING${kind === "risk" ? " RISK" : ""}: ${reason}` +
      (neighbour ? ` (next to ${neighbour})` : ""));
  }

  private resolve(name: string, why: string) {
    const alert = this.alerts.get(name);
    if (!alert) return;
    this.alerts.delete(name);
    if (alert.incident !== null) this.engine.store.resolveIncident(alert.incident, "system", why, "resolved");
  }

  /**
   * The spot physically next to this one, when the level file says where things are. A car
   * across two bays is usually across *these* two, and naming it saves an operator walking
   * the row. Without a level file there is no honest answer, so we give none.
   */
  private neighbourOf(spot: Spot): string | null {
    const placement = this.engine.placement;
    const here = placement?.spots.get(spot.name);
    if (!placement || !here) return null;
    let best: { name: string; d: number } | null = null;
    for (const other of this.engine.spots.values()) {
      if (other.name === spot.name || other.purpose !== SpotPurpose.Park || other.zone !== spot.zone) continue;
      const at = placement.spots.get(other.name);
      if (!at) continue;
      const d = Math.hypot(at.x - here.x, at.y - here.y);
      if (!best || d < best.d) best = { name: other.name, d };
    }
    return best?.name ?? null;
  }

  snapshot(): DoubleParkingSnapshot {
    return {
      watching: this.engine.cfg.doubleParkingWatch,
      warnings_total: this.warnings,
      open: [...this.alerts.values()].map((a) => ({
        kind: a.kind, spot: a.spot, zone: a.zone, plates: a.plates, reason: a.reason,
        neighbour: a.neighbour, incident: a.incident,
      })),
    };
  }
}
