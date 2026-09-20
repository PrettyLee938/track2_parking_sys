/**
 * Parking-spot sensor health, and maintenance mode for spots (Level 3 §7.2).
 *
 * "Support parking spots being placed into maintenance mode and temporarily removed from
 * availability due to sensor abnormalities."
 *
 * The simulator's REST API has no maintenance-mode command for a spot - only `repair`,
 * which is for a spot the simulator itself reports broken. So this is *our* soft lock:
 * the spot stays in the registry and on the dashboard, but `Spot.out_of_service` is set
 * and `Spot.available` turns false, so allocation stops offering it. Nothing is sent to
 * the simulator, which means nothing here can earn a penalty. (If Level 3 turns out to
 * have a maintenance endpoint, call it from clear()/lock() behind a new flag - see the
 * open questions in docs/LEVEL3_CONTEXT.md §9.)
 *
 * Why bother: a spot whose sensor lies is how one wrong decision becomes dozens of fines.
 * Sending a car to a spot that already holds one is "attempted to park in an occupied
 * spot", and the car parks there anyway - so every car sent there afterwards is fined too.
 *
 * The four signals, all from data we already hold:
 *   ghost      the sensor reports a car we have no plate for, on two consecutive syncs
 *   over_count it reports more cars than could possibly be there (we saw at most one CarIn)
 *   flapping   it changes its mind several times inside a short game window
 *   silent     cars we send here keep parking somewhere else - it never sees them
 *
 * Deliberately NOT here: two cars that each sent a real CarIn. That is genuine double
 * parking, not a broken sensor, and it is handled separately.
 *
 * Mode (GPA_SPOT_SENSOR_MODE):
 *   off          do nothing
 *   watch        detect and record incidents, change no behaviour (the default: locking
 *                spots is new behaviour and the team should switch it on deliberately)
 *   maintenance  also take the spot out of allocation until it reads clean again
 */
import { Direction, EventClass, SpotPurpose, type SensorFaultKind, type SpotSensorSnapshot } from "@gpa/shared";
import type { Spot } from "./controller";
import type { EventRecord } from "./store";
import type { Engine, Subsystem } from "./subsystems";

interface Watch {
  /** Consecutive syncs the signal has held for; a single odd reading is not a fault. */
  ghostSyncs: number;
  /** Consecutive clean syncs since we locked it. */
  cleanSyncs: number;
  /** Cars sent here that parked somewhere else instead. */
  misses: number;
  /** Game-clock stamps of recent sensor transitions (CarIn/CarOut), for flap detection. */
  flips: number[];
  /** How many CarIn events we have actually seen for the spot's current occupancy. */
  carIns: number;
  /** A car was reserved this spot and has not arrived yet; if it parks elsewhere, this
   * sensor never saw it. */
  pendingPlate: string | null;
  fault: SensorFaultKind | null;
  reason: string | null;
  since: number | null;
  incidentId: number | null;
  /** An operator overrode us: leave this spot alone until it reads clean. */
  operator: "in_service" | "out_of_service" | null;
}

const blank = (): Watch => ({
  ghostSyncs: 0, cleanSyncs: 0, misses: 0, flips: [], carIns: 0, pendingPlate: null,
  fault: null, reason: null, since: null, incidentId: null, operator: null,
});

export class SpotSensors implements Subsystem {
  readonly name = "spot_sensors";
  private readonly watched = new Map<string, Watch>();

  constructor(private readonly engine: Engine) {}

  private get mode() {
    return this.engine.cfg.spotSensorMode;
  }

  private watch(name: string): Watch {
    let w = this.watched.get(name);
    if (!w) this.watched.set(name, (w = blank()));
    return w;
  }

  // ---------------------------------------------------------------------------
  // signals from events
  // ---------------------------------------------------------------------------
  onEvent(e: EventRecord): void {
    if (this.mode === "off" || this.engine.replaying) return;
    if (e.EventClass !== EventClass.CarSpotAction || e.SpotType !== SpotPurpose.Park) return;
    const name = String(e.SpotName ?? "");
    if (!name) return;
    const w = this.watch(name);
    const now = this.engine.clock.now();

    // A sensor that changes its mind several times in a few game seconds is not watching
    // cars: cars take longer than that to arrive and leave.
    w.flips.push(now);
    const window = this.engine.cfg.spotFlapWindowGameS;
    while (w.flips.length && now - w.flips[0] > window) w.flips.shift();
    if (w.flips.length > this.engine.cfg.spotFlapMax && !w.fault) {
      this.raise(name, "flapping", `${w.flips.length} sensor changes in ${Math.round(window)} game-s`,
        { flips: w.flips.length, window_game_s: window });
    }

    if (e.Direction === Direction.In) {
      w.carIns++;
      w.misses = 0; // it does see cars after all
      // A car reached this spot, so anything it was previously blamed for is history.
      const plate = String(e.CarPlateNumber ?? "");
      for (const [other, ow] of this.watched) {
        if (other !== name && ow.pendingPlate === plate) this.missed(other, plate);
      }
    } else if (e.Direction === Direction.Out) {
      w.carIns = Math.max(0, w.carIns - 1);
    }
  }

  /** A car we sent to `name` turned up somewhere else: that sensor never saw it. */
  private missed(name: string, plate: string) {
    const w = this.watch(name);
    w.pendingPlate = null;
    w.misses++;
    if (w.misses >= this.engine.cfg.spotSilentMisses && !w.fault) {
      this.raise(name, "silent", `${w.misses} cars sent here parked elsewhere instead`,
        { misses: w.misses, last_plate: plate });
    }
  }

  /** The controller reserved a spot for a plate: remember who we are expecting. */
  reserved(name: string, plate: string): void {
    if (this.mode === "off" || this.engine.replaying) return;
    this.watch(name).pendingPlate = plate;
  }

  // ---------------------------------------------------------------------------
  // signals from the sensors themselves (list-parking-spots, on every sync)
  // ---------------------------------------------------------------------------
  onSync(): void {
    if (this.mode === "off" || this.engine.replaying) return;
    for (const spot of this.engine.spots.values()) {
      if (spot.purpose !== SpotPurpose.Park) continue;
      this.review(spot);
    }
  }

  private review(spot: Spot) {
    const w = this.watch(spot.name);
    const named = [...spot.occupants].filter((p) => p !== "?").length;

    // More cars on one sensor than we ever saw arrive. Genuine double parking shows two
    // CarIn events; this shape is the sensor counting wrong.
    if (spot.detected > 1 && w.carIns <= 1 && named <= 1 && !w.fault) {
      this.raise(spot.name, "over_count", `sensor reports ${spot.detected} cars but only ${w.carIns} arrived`,
        { detected: spot.detected, car_ins: w.carIns, occupants: [...spot.occupants] });
    }

    // A car the sensor sees but we cannot name. One reading is a car we lost track of;
    // two in a row, with no arrival ever recorded, is the sensor stuck.
    const ghost = spot.detected > 0 && named === 0 && w.carIns === 0;
    w.ghostSyncs = ghost ? w.ghostSyncs + 1 : 0;
    if (w.ghostSyncs >= this.engine.cfg.spotGhostSyncs && !w.fault) {
      this.raise(spot.name, "ghost", `sensor has reported ${spot.detected} car(s) for ${w.ghostSyncs} syncs with no arrival`,
        { detected: spot.detected, syncs: w.ghostSyncs });
    }

    // Back to normal? Only an empty, quiet sensor counts, and only for several syncs.
    const clean = spot.detected === 0 && !spot.occupants.size;
    w.cleanSyncs = clean ? w.cleanSyncs + 1 : 0;
    if (w.fault && w.cleanSyncs >= this.engine.cfg.spotSensorClearSyncs && w.operator !== "out_of_service") {
      this.clear(spot.name, `sensor read clean for ${w.cleanSyncs} consecutive syncs`);
    }
  }

  // ---------------------------------------------------------------------------
  // faults: record, lock, release
  // ---------------------------------------------------------------------------
  private raise(name: string, fault: SensorFaultKind, reason: string, evidence: Record<string, unknown>) {
    const w = this.watch(name);
    const spot = this.engine.spots.get(name);
    if (!spot || w.fault) return;
    w.fault = fault;
    w.reason = reason;
    w.since = this.engine.clock.now();
    w.cleanSyncs = 0;

    const confidence = fault === "over_count" || fault === "ghost" ? "high" : "medium";
    const incident = this.engine.store.createIncident({
      status: "open", kind: "spot_sensor_fault", zone: spot.zone || null, component: name,
      reason: `${name}: ${reason}`, confidence,
      evidence: { ...evidence, signal: fault, zone: spot.zone, mode: this.mode },
    });
    w.incidentId = incident.id;
    this.engine.store.createMaintenanceJob({
      kind: "spot", name, zone: spot.zone || null, status: "scheduled",
      reason: `sensor abnormality (${fault}): ${reason}`,
      evidence: { ...evidence, signal: fault, incident: incident.id },
    });
    this.engine.store.recordAudit({ action: "spot.sensor_fault", target: name, ok: true, reason,
      detail: { signal: fault, incident: incident.id, mode: this.mode } });

    if (this.mode === "maintenance" && this.mayLock(spot)) {
      spot.out_of_service = `sensor ${fault}: ${reason}`;
      this.engine.note("warn", `${name} taken out of service - ${reason} (incident #${incident.id})`);
    } else {
      // watch mode, or the zone has already lost as many spots as it can afford.
      this.engine.note("warn", `${name} sensor looks wrong - ${reason} (incident #${incident.id}); still in service`);
    }
  }

  /**
   * Never lock so much of a zone that we start turning cars away over suspicion. A wrong
   * sensor costs one penalty; an empty zone nobody is sent to costs every arrival.
   */
  private mayLock(spot: Spot): boolean {
    const park = [...this.engine.spots.values()].filter((s) => s.purpose === SpotPurpose.Park && s.zone === spot.zone);
    const locked = park.filter((s) => s.out_of_service !== null).length;
    const ceiling = Math.floor(park.length * this.engine.cfg.spotSensorMaxLockedRatio);
    if (locked < Math.max(1, ceiling)) return true;
    this.engine.note("error", `${spot.zone}: ${locked} spots are already out of service for sensor faults - keeping ${spot.name} in service`);
    return false;
  }

  /** Back in service: by itself after clean syncs, or because an operator said so. */
  private clear(name: string, why: string, actor: string | null = null) {
    const w = this.watch(name);
    const spot = this.engine.spots.get(name);
    if (spot) spot.out_of_service = null;
    if (w.incidentId !== null) {
      this.engine.store.resolveIncident(w.incidentId, actor ?? "system", why, "resolved");
    }
    this.engine.store.updateMaintenanceJob("spot", name, "completed", { resolution: why, actor });
    this.engine.store.recordAudit({ actor, action: "spot.back_in_service", target: name, ok: true, reason: why });
    this.engine.note("info", `${name} is back in service: ${why}`);
    const keepOperator = w.operator;
    Object.assign(w, blank(), { operator: keepOperator === "out_of_service" ? null : keepOperator });
  }

  // ---------------------------------------------------------------------------
  // operator control
  // ---------------------------------------------------------------------------
  /** An operator puts a spot into, or takes it out of, our maintenance mode. */
  setService(name: string, inService: boolean, actor: string, reason: string): { ok: boolean; message: string } {
    const spot = this.engine.spots.get(name);
    if (!spot || spot.purpose !== SpotPurpose.Park) return { ok: false, message: `unknown parking spot ${name}` };
    const w = this.watch(name);
    if (inService) {
      w.operator = "in_service";
      if (!w.fault && spot.out_of_service === null) return { ok: true, message: `${name} was already in service` };
      this.clear(name, reason || `returned to service by ${actor}`, actor);
      return { ok: true, message: `${name} is back in service` };
    }
    if (spot.occupants.size || spot.reserved_for) {
      // Not a penalty (we send nothing), but a car on its way would be stranded.
      return { ok: false, message: `${name} is occupied or reserved - wait until it is empty` };
    }
    w.operator = "out_of_service";
    w.fault = w.fault ?? "operator";
    w.reason = reason || `taken out of service by ${actor}`;
    w.since = this.engine.clock.now();
    spot.out_of_service = w.reason;
    const incident = this.engine.store.createIncident({
      status: "open", kind: "spot_sensor_fault", zone: spot.zone || null, component: name,
      reason: `${name}: ${w.reason}`, confidence: "high", evidence: { signal: "operator", actor },
    });
    w.incidentId = incident.id;
    this.engine.store.createMaintenanceJob({ kind: "spot", name, zone: spot.zone || null, status: "scheduled",
      reason: w.reason, actor, evidence: { signal: "operator", incident: incident.id } });
    this.engine.store.recordAudit({ actor, permission: "repair", action: "spot.out_of_service", target: name, ok: true, reason: w.reason });
    this.engine.note("warn", `${actor} took ${name} out of service: ${w.reason}`);
    return { ok: true, message: `${name} is out of service and will not be offered to cars` };
  }

  snapshot(): SpotSensorSnapshot {
    const faults = [...this.watched.entries()].filter(([, w]) => w.fault !== null);
    const outOfService = [...this.engine.spots.values()].filter((s) => s.out_of_service !== null);
    return {
      mode: this.mode,
      faults: faults.length,
      out_of_service: outOfService.length,
      spots: faults.map(([name, w]) => ({
        spot: name, zone: this.engine.spots.get(name)?.zone ?? "", signal: w.fault!, reason: w.reason ?? "",
        since_game_s: w.since, incident: w.incidentId, locked: this.engine.spots.get(name)?.out_of_service !== null,
      })),
    };
  }
}
