const { verifyWebhookSignature } = require('./signature.cjs');

const COMPONENT_TYPES = {
  BarrierGate: 'barrier',
  ParkingSpot: 'parking_spot',
  ExhaustFan: 'exhaust_fan',
  Light: 'light',
};

function simulatorTimestamp(payload) {
  return payload.ServerDateTime || new Date().toISOString();
}

function parseSimulatorTime(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

class EventService {
  constructor(database, options = {}) {
    this.database = database;
    this.requireWebhookSignature = Boolean(options.requireWebhookSignature);
    this.simulator = options.simulator || null;
    this.autoAssign = options.autoAssign !== false;
    this.autoCharge = options.autoCharge !== false;
    this.rejectWhenFull = options.rejectWhenFull !== false;
    this.maxEntryQueue = options.maxEntryQueue === undefined ? 5 : Number(options.maxEntryQueue);
    this.entryGateName = options.entryGateName || null;
    this.exitGateName = options.exitGateName || null;
    this.chargeDelayMs = options.chargeDelayMs === undefined ? 1500 : Number(options.chargeDelayMs);
    this.releaseTimeoutMs = options.releaseTimeoutMs === undefined
      ? 30000
      : Number(options.releaseTimeoutMs);
    this.rechargeAfterMs = options.rechargeAfterMs === undefined ? 4000 : Number(options.rechargeAfterMs);
    this.maxRechargeAttempts = options.maxRechargeAttempts === undefined
      ? 2
      : Number(options.maxRechargeAttempts);
    this.paymentConfirmTimeoutMs = options.paymentConfirmTimeoutMs === undefined
      ? 5000
      : Number(options.paymentConfirmTimeoutMs);
    this.simulatedMinuteSeconds = options.simulatedMinuteSeconds === undefined
      ? 10
      : Number(options.simulatedMinuteSeconds);
    this.gateCloseTimeoutMs = options.gateCloseTimeoutMs === undefined
      ? 5000
      : Number(options.gateCloseTimeoutMs);
    this.gateSettleMs = options.gateSettleMs === undefined ? 2000 : Number(options.gateSettleMs);
    this.staleAssignmentMs = options.staleAssignmentMs === undefined ? 120000 : Number(options.staleAssignmentMs);
    this.reconcileIntervalMs = options.reconcileIntervalMs === undefined ? 60000 : Number(options.reconcileIntervalMs);
    this.lastReconcileAt = 0;
    // No parking decisions until a level has actually been discovered.
    this.ready = false;
    this.dispatching = false;
    this.dispatchAgain = false;
    this.warnedMissingGate = false;
    this.releasingPlate = null;
    this.releasingSince = 0;
    this.rechargeAttempts = new Map();
  }

  process(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { accepted: false, status: 400, error: 'Webhook body must be a JSON object' };
    }
    if (!payload.EventClass || !payload.EventId) {
      return { accepted: false, status: 400, error: 'EventClass and EventId are required' };
    }

    const signature = verifyWebhookSignature(payload, this.requireWebhookSignature);
    if (!signature.accepted) {
      return { accepted: false, status: 401, error: `Webhook signature is ${signature.status}` };
    }
    if (this.database.hasEvent(payload.EventId)) {
      return { accepted: true, status: 200, duplicate: true, signatureStatus: signature.status };
    }

    const sequenceStatus = this.sequenceStatus(payload.SequenceId);
    this.database.insertEvent(payload, signature.status, sequenceStatus);
    this.applyEvent(payload);
    return {
      accepted: true,
      status: 202,
      duplicate: false,
      signatureStatus: signature.status,
      sequenceStatus,
    };
  }

  sequenceStatus(sequenceValue) {
    const sequence = Number(sequenceValue);
    if (!Number.isFinite(sequence)) return 'missing';
    const previousValue = this.database.getMetadata('last_sequence_id');
    const previous = previousValue === null ? null : Number(previousValue);
    let status = 'ok';
    if (previous === null || !Number.isFinite(previous)) status = 'first';
    else if (sequence === previous) status = 'duplicate_sequence';
    else if (sequence < previous) status = 'out_of_order';
    else if (sequence > previous + 1) status = 'gap';
    if (previous === null || !Number.isFinite(previous) || sequence > previous) {
      this.database.setMetadata('last_sequence_id', sequence);
    }
    return status;
  }

  applyEvent(payload) {
    switch (payload.EventClass) {
      case 'car_spot_action':
        this.applyCarSpotAction(payload);
        break;
      case 'payment_made':
        if (payload.CarPlateNumber) {
          this.database.upsertCar(payload.CarPlateNumber, {
            payment_status: 'received',
            paid_amount: Number(payload.Amount),
            last_event_at: simulatorTimestamp(payload),
          });
        }
        break;
      case 'component_broken':
      case 'component_fixed':
        this.applyComponentEvent(payload);
        break;
      case 'gate_action':
        this.mergeComponent('barrier', payload.Name, {
          state: payload.Action,
          lastEventAt: simulatorTimestamp(payload),
        });
        break;
      case 'carbon_monoxide_event':
        this.mergeComponent('zone', payload.ZoneName, {
          name: payload.ZoneName,
          gasCarbonMonoxideLevel: payload.CarbonMonoxideLevel,
          risk: payload.DangerLevel,
          lastEventAt: simulatorTimestamp(payload),
        });
        break;
      default:
        break;
    }
  }

  applyCarSpotAction(payload) {
    const plate = payload.CarPlateNumber;
    if (!plate) return;
    const timestamp = simulatorTimestamp(payload);
    const base = {
      car_type: payload.CarType || undefined,
      // Exit events carry PlannedParkingDurationInMinutes: "0", which would wipe
      // the real duration declared on arrival and leave nothing to bill.
      planned_minutes: Number(payload.PlannedParkingDurationInMinutes) > 0
        ? Number(payload.PlannedParkingDurationInMinutes)
        : undefined,
      last_event_at: timestamp,
    };

    if (payload.SpotType === 'EntrySpot' && payload.Direction === 'CarIn') {
      // Plates are reused when cars respawn, so arriving at the entry spot starts
      // a NEW journey on an existing row. Every field from the previous visit has
      // to be cleared: a stale payment_status of "received" makes the car look
      // already paid, so it is never charged and the simulator fines us with
      // "Car should be charged at the exit", and stale timestamps would price the
      // previous stay. Dropping the reservation also stops that spot leaking.
      this.database.upsertCar(plate, {
        ...base,
        status: 'waiting_entry',
        entered_at: timestamp,
        assigned_spot: null,
        current_spot: null,
        parked_at: null,
        departed_spot_at: null,
        arrived_exit_at: null,
        exited_at: null,
        payment_status: 'not_requested',
        paid_amount: null,
      });
      this.rechargeAttempts.delete(plate);
    } else if (payload.SpotType === 'EntrySpot' && payload.Direction === 'CarOut') {
      this.database.upsertCar(plate, { ...base, status: 'inside' });
    } else if (payload.SpotType === 'Park' && payload.Direction === 'CarIn') {
      this.database.upsertCar(plate, {
        ...base,
        status: 'parked',
        current_spot: payload.SpotName,
        assigned_spot: payload.SpotName,
        parked_at: timestamp,
      });
      this.mergeDetectedCar(payload.SpotName, plate, true);
    } else if (payload.SpotType === 'Park' && payload.Direction === 'CarOut') {
      this.database.upsertCar(plate, {
        ...base,
        status: 'heading_to_exit',
        current_spot: null,
        // Release the reservation so the freed spot can be handed to a queued car.
        assigned_spot: null,
        departed_spot_at: timestamp,
      });
      this.mergeDetectedCar(payload.SpotName, plate, false);
    } else if (payload.SpotType === 'ExitSpot' && payload.Direction === 'CarIn') {
      this.database.upsertCar(plate, { ...base, status: 'at_exit', arrived_exit_at: timestamp });
    } else if (payload.SpotType === 'ExitSpot' && payload.Direction === 'CarOut') {
      this.rechargeAttempts.delete(plate);
      this.database.upsertCar(plate, {
        ...base, status: 'departed', assigned_spot: null, exited_at: timestamp,
      });
    }
  }

  mergeDetectedCar(spotName, plate, isPresent) {
    const current = this.database.getComponent('parking_spot', spotName) || {
      name: spotName,
      purpose: 'Park',
      detectedCars: [],
    };
    const cars = new Set(Array.isArray(current.detectedCars) ? current.detectedCars : []);
    if (isPresent) cars.add(plate);
    else cars.delete(plate);
    this.database.upsertComponent('parking_spot', { ...current, detectedCars: [...cars] });
  }

  applyComponentEvent(payload) {
    const componentType = COMPONENT_TYPES[payload.Type] || String(payload.Type || 'component').toLowerCase();
    const fixed = payload.EventClass === 'component_fixed';
    this.mergeComponent(componentType, payload.Name, {
      broken: !fixed,
      isUnderMaintenance: false,
      lastEventAt: simulatorTimestamp(payload),
    });
  }

  mergeComponent(componentType, name, patch) {
    if (!name) return;
    const current = this.database.getComponent(componentType, name) || { name };
    delete current._type;
    delete current._updatedAt;
    this.database.upsertComponent(componentType, { ...current, ...patch, name });
  }

  // True once we know the level's layout. Until then the park is unknown, not
  // full, and a car must never be turned away on the strength of an empty table.
  knownParkSpots() {
    return this.database
      .listComponents('parking_spot')
      .filter((spot) => spot.purpose === 'Park').length;
  }

  storeSync(snapshot) {
    this.database.replaceComponents('parking_spot', snapshot.parkingSpots || []);
    this.database.replaceComponents('barrier', snapshot.barriers || []);
    this.database.replaceComponents('light', snapshot.lights || []);
    this.database.replaceComponents('exhaust_fan', snapshot.exhaustFans || []);
    this.database.replaceComponents('alarm', snapshot.alarms || []);
    this.database.replaceComponents('zone', snapshot.zones || []);
    this.database.setMetadata('last_sync_at', new Date().toISOString());
    this.ready = this.knownParkSpots() > 0;
  }

  // Ready means an initial sync has happened and the level actually has spots.
  // Either being false makes every spot lookup fail for reasons that have nothing
  // to do with the park being full.
  isReady() {
    return Boolean(this.database.getMetadata('last_sync_at')) && this.parkSpotCount() > 0;
  }

  parkSpotCount() {
    return this.database
      .listComponents('parking_spot')
      .filter((spot) => spot.purpose === 'Park').length;
  }

  // Cars that are in the park but have not been given a spot yet, oldest first.
  pendingCars() {
    return this.database
      .listCars({ limit: 500 })
      .filter((car) => ['waiting_entry', 'inside'].includes(car.status) && !car.assigned_spot)
      .sort((left, right) => String(left.entered_at || '').localeCompare(String(right.entered_at || '')));
  }

  // Entry routing must use one known gate. Opening every gate in a zone lets an
  // unassigned car escape through another route.
  gatesForSpot(spot) {
    if (this.entryGateName) return [this.entryGateName];
    const zone = spot ? spot.zoneParent : null;
    return this.database
      .listComponents('barrier')
      .filter((barrier) => !barrier.zoneParent || (zone && barrier.zoneParent === zone))
      .map((barrier) => barrier.name);
  }

  async openGatesForSpot(spot) {
    const names = this.gatesForSpot(spot);
    if (!names.length) {
      if (!this.warnedMissingGate) {
        this.warnedMissingGate = true;
        console.warn('No barrier found for the destination zone; set ENTRY_GATE_NAME to override');
      }
      return;
    }
    let opened = false;
    for (const name of names) {
      const barrier = this.database.getComponent('barrier', name);
      if (!barrier) throw new Error(`Configured entry gate ${name} was not discovered`);
      if (barrier && (barrier.broken || barrier.isUnderMaintenance)) continue;
      if (barrier && barrier.state === 'Open') continue;
      await this.runCommand('auto.barrier.open', name, () => this.simulator.openBarrier(name));
      // Record it locally so the next car does not re-issue the same command.
      this.mergeComponent('barrier', name, { state: 'Open' });
      opened = true;
    }

    // A barrier passes through Opening before it is Open. Sending a car at a gate
    // still in motion strands it, so let the transition finish. Only the first car
    // through a shut gate pays this cost; later cars see the cached Open state.
    if (opened && this.gateSettleMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, this.gateSettleMs); });
    }
  }

  // Re-sends the drive command for cars that were assigned but never arrived,
  // for example because a zone gate was shut when they were first dispatched.
  async redriveAssignedCars() {
    const stuck = this.database
      .listCars({ limit: 500 })
      .filter((car) => car.assigned_spot && !car.parked_at && ['assigned', 'inside'].includes(car.status));
    const redriven = [];
    const failed = [];
    for (const car of stuck) {
      const spot = this.database.getComponent('parking_spot', car.assigned_spot);
      try {
        await this.openGatesForSpot(spot);
        await this.runCommand(
          'auto.car.redrive',
          `${car.plate}:${car.assigned_spot}`,
          () => this.simulator.moveCar(car.plate, car.assigned_spot),
        );
        redriven.push({ plate: car.plate, spot: car.assigned_spot });
      } catch (error) {
        failed.push({ plate: car.plate, error: error.message });
      }
    }
    return { redriven, failed };
  }

  async runCommand(action, target, operation) {
    const commandId = this.database.createCommand(action, target, 'auto-dispatch');
    try {
      const result = await operation();
      this.database.completeCommand(commandId, 'completed', result ? result.body : null);
      return result;
    } catch (error) {
      const detail = error.details ? `${error.message} :: ${error.details}` : error.message;
      this.database.completeCommand(commandId, 'failed', null, detail);
      throw error;
    }
  }

  // Returns the spot name, or null when no compatible spot is free.
  async assignCar(car, options = {}) {
    const spot = this.database.findAvailableSpot(car.car_type);
    if (!spot) return null;

    // Reserve before commanding so a second pass cannot hand out the same spot.
    this.database.upsertCar(car.plate, { assigned_spot: spot.name, status: 'assigned' });
    try {
      // A car already past the entry spot needs a destination, not a gate.
      if (options.openGates !== false) await this.openGatesForSpot(spot);
      await this.runCommand(
        'auto.car.assign',
        `${car.plate}:${spot.name}`,
        () => this.simulator.moveCar(car.plate, spot.name),
      );
    } catch (error) {
      this.database.upsertCar(car.plate, { assigned_spot: null, status: car.status });
      throw error;
    }
    return spot.name;
  }

  // Only a car assigned recently is genuinely still driving in. One whose
  // assignment has gone stale must not hold the entry cycle shut forever, which
  // both blocks every other car and leaves the gate stuck open.
  carAwaitingEntry(now = Date.now()) {
    return this.database
      .listCars({ limit: 500 })
      .find((car) => {
        if (car.status !== 'assigned' || !car.assigned_spot || car.parked_at) return false;
        if (!(this.staleAssignmentMs > 0)) return true;
        const since = Date.parse(car.updated_at);
        return !Number.isFinite(since) || now - since < this.staleAssignmentMs;
      }) || null;
  }

  // The simulator does not reliably deliver the confirming gate_action webhook,
  // and a gate left in Closing would block every future admission. Treat a
  // Closing that has outlived the timeout as closed instead of deadlocking.
  entryGateIsClosed(now = Date.now()) {
    return this.gateIsClosed(this.entryGateName, now);
  }

  gateIsClosed(name, now = Date.now()) {
    const gate = this.database.getComponent('barrier', name);
    if (!gate) return false;
    if (gate.state === 'Closed') return true;
    if (gate.state !== 'Closing') return false;
    if (!(this.gateCloseTimeoutMs > 0)) return false;
    const since = Number(gate.closingAt);
    // An unstamped Closing predates this logic, so do not wait forever for it.
    if (!Number.isFinite(since)) return true;
    return now - since >= this.gateCloseTimeoutMs;
  }

  async closeEntryGateIfIdle() {
    if (!this.entryGateName || this.carAwaitingEntry()) return { closed: false, busy: true };
    const barrier = this.database.getComponent('barrier', this.entryGateName);
    if (!barrier) return { closed: false, missing: true };
    if (barrier.broken || barrier.isUnderMaintenance) return { closed: false, unavailable: true };
    if (barrier.state === 'Closed' || barrier.state === 'Closing') return { closed: false };

    await this.runCommand(
      'auto.barrier.close',
      barrier.name,
      () => this.simulator.closeBarrier(barrier.name),
    );
    this.mergeComponent('barrier', barrier.name, { state: 'Closing', closingAt: Date.now() });
    return { closed: true, name: barrier.name };
  }

  // Barriers that are neither the entry nor the exit gate carry the route between
  // the entrance and the parking spots. The simulator validates a path before it
  // spawns a car, so leaving one of these shut stops the level dead with
  // "Won't spawn car No path from A to P2". Make sure they are open.
  async openRouteBarriers() {
    const opened = [];
    const failed = [];
    for (const barrier of this.database.listComponents('barrier')) {
      if (barrier.name === this.entryGateName || barrier.name === this.exitGateName) continue;
      if (barrier.broken || barrier.isUnderMaintenance) continue;
      if (barrier.state === 'Open' || barrier.state === 'Opening') continue;
      try {
        await this.runCommand(
          'auto.barrier.open',
          barrier.name,
          () => this.simulator.openBarrier(barrier.name),
        );
        this.mergeComponent('barrier', barrier.name, { state: 'Open' });
        opened.push(barrier.name);
      } catch (error) {
        failed.push({ name: barrier.name, error: error.message });
      }
    }
    return { opened, failed };
  }

  // The exit barrier opens for a car that has paid, not merely one that has
  // arrived. This build delivers payment_made for only about a quarter of
  // charges, so a car whose confirmation never lands is released once
  // paymentConfirmTimeoutMs has passed; without that most cars would be trapped
  // at the exit forever. Set PAYMENT_CONFIRM_TIMEOUT_MS=0 to demand the webhook.
  carAwaitingRelease(now = Date.now()) {
    return this.database
      .listCars({ limit: 500 })
      .find((car) => {
        if (!['at_exit', 'heading_to_exit'].includes(car.status)) return false;
        if (['received', 'verified'].includes(car.payment_status)) return true;
        if (car.payment_status !== 'requested') return false;
        if (!(this.paymentConfirmTimeoutMs > 0)) return false;
        const since = Date.parse(car.updated_at);
        return Number.isFinite(since) && now - since >= this.paymentConfirmTimeoutMs;
      }) || null;
  }

  // The exit barrier stays shut and opens only while a car is actually leaving.
  async openExitGate() {
    if (!this.exitGateName) return { opened: false };
    const barrier = this.database.getComponent('barrier', this.exitGateName);
    if (!barrier) return { opened: false, missing: true };
    if (barrier.broken || barrier.isUnderMaintenance) return { opened: false, unavailable: true };
    if (barrier.state === 'Open' || barrier.state === 'Opening') return { opened: false };

    await this.runCommand(
      'auto.barrier.open',
      barrier.name,
      () => this.simulator.openBarrier(barrier.name),
    );
    this.mergeComponent('barrier', barrier.name, { state: 'Open' });
    return { opened: true, name: barrier.name };
  }

  async closeExitGateIfIdle() {
    if (!this.exitGateName || this.releasingPlate) return { closed: false, busy: true };
    const barrier = this.database.getComponent('barrier', this.exitGateName);
    if (!barrier) return { closed: false, missing: true };
    if (barrier.broken || barrier.isUnderMaintenance) return { closed: false, unavailable: true };
    if (barrier.state === 'Closed' || barrier.state === 'Closing') return { closed: false };

    await this.runCommand(
      'auto.barrier.close',
      barrier.name,
      () => this.simulator.closeBarrier(barrier.name),
    );
    this.mergeComponent('barrier', barrier.name, { state: 'Closing', closingAt: Date.now() });
    return { closed: true, name: barrier.name };
  }

  // A charge whose payment_made never arrives leaves the car parked on the exit
  // spot forever, which eventually blocks the exit for everyone. Re-issue the
  // charge a limited number of times; the simulator itself fines us with
  // "Car should be charged at the exit" when a car sits there unbilled.
  async rechargeStalledExits(now = Date.now()) {
    const recharged = [];
    const failed = [];
    if (!(this.rechargeAfterMs > 0)) return { recharged, failed };

    for (const car of this.database.listCars({ status: 'at_exit', limit: 500 })) {
      if (car.payment_status !== 'requested') continue;
      const since = Date.parse(car.updated_at);
      if (Number.isFinite(since) && now - since < this.rechargeAfterMs) continue;
      const tries = this.rechargeAttempts.get(car.plate) || 0;
      if (tries >= this.maxRechargeAttempts) continue;

      const quote = this.quoteForCar(car.plate);
      if (!quote || !quote.available) continue;
      this.rechargeAttempts.set(car.plate, tries + 1);
      try {
        await this.runCommand(
          'auto.car.recharge',
          `${car.plate}:${quote.totalCost}`,
          () => this.simulator.chargeCar(car.plate, quote.parkingCost, quote.chargingCost),
        );
        this.database.upsertCar(car.plate, { payment_status: 'requested' });
        recharged.push({ plate: car.plate, attempt: tries + 1 });
      } catch (error) {
        failed.push({ plate: car.plate, error: error.message });
      }
    }
    return { recharged, failed };
  }

  // The simulator releases a car once it has paid, so charging is the whole exit
  // flow. The API docs require the car to have reached an exit spot first.
  async chargeCarsAtExit(now = Date.now()) {
    const charged = [];
    const failed = [];
    const waiting = this.database
      .listCars({ status: 'at_exit', limit: 500 })
      .filter((car) => car.payment_status === 'not_requested')
      // A car is not settled on the exit spot the instant its webhook fires.
      // Measured: every charge sent within ~0.25s of arrival was silently
      // ignored and had to be retried, while every charge after ~1.1s worked.
      // Charging too early also earns "Car should be charged at the exit".
      .filter((car) => {
        if (!(this.chargeDelayMs > 0)) return true;
        const since = Date.parse(car.updated_at);
        return !Number.isFinite(since) || now - since >= this.chargeDelayMs;
      });

    for (const car of waiting) {
      const quote = this.quoteForCar(car.plate);
      if (!quote || !quote.available) {
        failed.push({ plate: car.plate, error: quote ? quote.reason : 'No quote available' });
        continue;
      }
      try {
        await this.runCommand(
          'auto.car.charge',
          `${car.plate}:${quote.totalCost}`,
          () => this.simulator.chargeCar(car.plate, quote.parkingCost, quote.chargingCost),
        );
        this.database.upsertCar(car.plate, { payment_status: 'requested' });
        charged.push({
          plate: car.plate,
          parkingCost: quote.parkingCost,
          chargingCost: quote.chargingCost,
        });
      } catch (error) {
        failed.push({ plate: car.plate, error: error.message });
      }
    }
    return { charged, failed };
  }

  // Retained for manual recovery. Normal startup closes only the configured
  // entry gate; exit and upstream gates keep their level-defined state.
  async closeAllBarriers() {
    const closed = [];
    const failed = [];
    for (const barrier of this.database.listComponents('barrier')) {
      if (barrier.broken || barrier.isUnderMaintenance) {
        failed.push({ name: barrier.name, error: 'broken or under maintenance' });
        continue;
      }
      try {
        await this.runCommand(
          'auto.barrier.close',
          barrier.name,
          () => this.simulator.closeBarrier(barrier.name),
        );
        this.mergeComponent('barrier', barrier.name, { state: 'Closed' });
        closed.push(barrier.name);
      } catch (error) {
        failed.push({ name: barrier.name, error: error.message });
      }
    }
    return { closed, failed };
  }

  // A car that was sent to a spot but never arrived holds that spot hostage.
  // This happens when the simulator's cars are reset underneath us.
  releaseStaleReservations(now = Date.now()) {
    const released = [];
    const candidates = this.database
      .listCars({ limit: 500 })
      .filter((car) => car.assigned_spot && !['departed', 'parked'].includes(car.status));

    for (const car of candidates) {
      // A car at the entrance or already at the exit holds no spot, whatever the
      // clock says. Cars still in transit get the grace period.
      const cannotHoldSpot = ['waiting_entry', 'heading_to_exit', 'at_exit'].includes(car.status);
      if (!cannotHoldSpot) {
        if (!(this.staleAssignmentMs > 0)) continue;
        const updated = Date.parse(car.updated_at);
        if (Number.isFinite(updated) && now - updated < this.staleAssignmentMs) continue;
      }

      const patch = { assigned_spot: null };
      // Only a pre-park car goes back in the queue; do not drag an exiting car back.
      if (['assigned', 'inside'].includes(car.status)) patch.status = 'waiting_entry';
      this.database.upsertCar(car.plate, patch);
      released.push({ plate: car.plate, spot: car.assigned_spot });
    }
    return released;
  }

  // Cached occupancy can drift from the simulator, which strands every spot and
  // stalls the whole park. When cars are queued but nothing looks free, refresh
  // from the simulator. Rate limited, because list-* calls carry a cost.
  async reconcileIfStalled(now = Date.now()) {
    if (!(this.reconcileIntervalMs > 0)) return null;
    if (!this.pendingCars().length) return null;
    if (this.database.findAvailableSpot('Normal')) return null;
    if (now - this.lastReconcileAt < this.reconcileIntervalMs) return null;

    this.lastReconcileAt = now;
    const snapshot = await this.simulator.syncAll();
    this.storeSync(snapshot);
    const spots = this.database.listComponents('parking_spot');
    return {
      resynchronized: true,
      freeAfter: spots.filter((spot) => spot.purpose === 'Park' && !spot.detectedCars).length,
    };
  }

  // With the park full, extra cars must not pile up on the entry spot: once it
  // overflows the simulator gridlocks and no car can move at all. Send the
  // surplus out through an escape route instead.
  async turnAwayOverflow() {
    const turnedAway = [];
    const failed = [];
    if (!this.rejectWhenFull) return { turnedAway, failed };
    if (this.knownParkSpots() === 0) return { turnedAway, failed };

    for (const car of this.pendingCars().slice(Math.max(this.maxEntryQueue, 0))) {
      try {
        await this.runCommand(
          'auto.car.reject',
          car.plate,
          () => this.simulator.moveCar(car.plate, 'leavepark'),
        );
        this.database.upsertCar(car.plate, { status: 'turned_away' });
        turnedAway.push(car.plate);
      } catch (error) {
        failed.push({ plate: car.plate, error: error.message });
      }
    }
    return { turnedAway, failed };
  }

  async runDispatch(options = {}) {
    if (!this.simulator || !this.autoAssign) {
      return { enabled: false, assigned: [], failed: [], waiting: this.pendingCars().length };
    }
    // Claim the pass before doing any work. A webhook and the heartbeat can fire
    // together, and charging a car twice is a penalty.
    if (this.dispatching) {
      this.dispatchAgain = true;
      return { enabled: true, deferred: true, assigned: [], failed: [] };
    }
    this.dispatching = true;

    const assigned = [];
    const failed = [];
    let rejected = [];
    let redrive = null;
    let exits = null;
    let released = [];
    let reconciled = null;
    try {
      // Do nothing at all until an initial sync has given us the level. With no
      // spots cached every lookup fails, an empty park looks like a full one, and
      // every arriving car would be sent straight back out of the exit.
      if (!this.isReady()) {
        return {
          enabled: true,
          notReady: true,
          skipped: 'waiting for the level to be synchronized',
          assigned,
          failed,
          waiting: this.pendingCars().length,
        };
      }

      redrive = options.redrive ? await this.redriveAssignedCars() : null;
      // Release one paid car at a time and shut the barrier behind it. Leaving it
      // open lets an unpaid car follow the paid one out, which the simulator
      // fines as "Car escaped without paying after parking for some time."
      if (this.exitGateName) {
        if (this.releasingPlate) {
          const car = this.database.getCar(this.releasingPlate);
          const stuck = this.releaseTimeoutMs > 0
            && Date.now() - this.releasingSince >= this.releaseTimeoutMs;
          // Stop holding the way open for a car that has gone, or one that never
          // left: an unbounded open gate is how unpaid cars escape.
          if (!car || car.status === 'departed' || stuck) {
            if (stuck && car) {
              console.warn(`${this.releasingPlate} never left the exit; closing ${this.exitGateName}`);
            }
            this.releasingPlate = null;
            this.releasingSince = 0;
          }
        }
        if (this.releasingPlate) {
          await this.openExitGate(); // Still leaving; keep the way out open.
        } else {
          const closed = await this.closeExitGateIfIdle();
          const next = this.carAwaitingRelease();
          if (next && !closed.closed && this.gateIsClosed(this.exitGateName)) {
            await this.openExitGate();
            this.releasingPlate = next.plate;
            this.releasingSince = Date.now();
          }
        }
      }
      exits = this.autoCharge ? await this.chargeCarsAtExit() : null;
      const retried = this.autoCharge ? await this.rechargeStalledExits() : null;
      if (retried && retried.recharged.length && exits) exits.recharged = retried.recharged;
      released = this.releaseStaleReservations();
      try {
        reconciled = await this.reconcileIfStalled();
      } catch (error) {
        console.warn(`Reconciliation failed: ${error.message}`);
      }

      // Admit one car per gate cycle. Once its EntrySpot/CarOut webhook arrives,
      // the next pass closes the gate. A later pass admits the next queued car.
      // Cars that slipped past the entry spot while the gate was open are inside
      // with no destination. They need a spot immediately and no gate at all;
      // leaving them to the one-car gate cycle strands them and empties the park.
      let full = false;
      for (const car of this.pendingCars().filter((c) => c.status === 'inside')) {
        try {
          const spotName = await this.assignCar(car, { openGates: false });
          if (!spotName) { full = true; break; }
          assigned.push({ plate: car.plate, spot: spotName });
        } catch (error) {
          failed.push({ plate: car.plate, error: error.message });
        }
      }

      if (this.entryGateName) {
        const gateResult = await this.closeEntryGateIfIdle();
        if (!this.carAwaitingEntry() && !gateResult.closed && this.entryGateIsClosed()) {
          const car = this.pendingCars().find((c) => c.status === 'waiting_entry');
          if (car) {
            try {
              const spotName = await this.assignCar(car);
              if (spotName) assigned.push({ plate: car.plate, spot: spotName });
              else full = true;
            } catch (error) {
              failed.push({ plate: car.plate, error: error.message });
            }
          }
        }
      } else {
        // Compatibility mode for layouts without an explicitly configured entry
        // gate. Production Level 1 always sets ENTRY_GATE_NAME=gateA.
        for (const car of this.pendingCars()) {
          try {
            const spotName = await this.assignCar(car);
            if (!spotName) { full = true; break; }
            assigned.push({ plate: car.plate, spot: spotName });
          } catch (error) {
            failed.push({ plate: car.plate, error: error.message });
          }
        }
      }
      if (full) {
        const overflow = await this.turnAwayOverflow();
        rejected = overflow.turnedAway;
        failed.push(...overflow.failed);
      }
    } finally {
      this.dispatching = false;
    }

    return {
      enabled: true,
      assigned,
      failed,
      waiting: this.pendingCars().length,
      ...(exits ? { exits } : {}),
      ...(rejected.length ? { rejected } : {}),
      ...(released.length ? { released } : {}),
      ...(reconciled ? { reconciled } : {}),
      ...(redrive ? { redrive } : {}),
    };
  }

  quoteForCar(plate) {
    const car = this.database.getCar(plate);
    if (!car) return null;
    // The simulator compresses time: one parking minute is about ten real
    // seconds, so wall-clock minutes round every stay down to the 1 unit minimum.
    // PlannedParkingDurationInMinutes is the simulator's own duration, so bill
    // that, and fall back to converting real seconds when it is unknown.
    let minutes = Number(car.planned_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      const start = parseSimulatorTime(car.parked_at);
      const end = parseSimulatorTime(car.departed_spot_at || car.arrived_exit_at);
      if (!start || !end) return { car, available: false, reason: 'Parking timestamps are incomplete' };
      const seconds = (end - start) / 1000;
      const perMinute = this.simulatedMinuteSeconds > 0 ? this.simulatedMinuteSeconds : 60;
      minutes = Math.ceil(seconds / perMinute);
    }
    minutes = Math.max(1, Math.round(minutes));
    return {
      car,
      available: true,
      parkedMinutes: minutes,
      parkingCost: minutes,
      chargingCost: car.car_type === 'Electric' ? minutes * 2 : 0,
      totalCost: minutes + (car.car_type === 'Electric' ? minutes * 2 : 0),
    };
  }
}

module.exports = { EventService, parseSimulatorTime };
