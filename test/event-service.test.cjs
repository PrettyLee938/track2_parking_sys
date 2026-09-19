const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ParkingDatabase } = require('../src/database.cjs');
const { EventService } = require('../src/event-service.cjs');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-events-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0 });
  return { database, events };
}

test('stores idempotent car events and derives parking state and charges', () => {
  const { database, events } = fixture();
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Electric', detectedCars: [], broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  const base = {
    EventClass: 'car_spot_action',
    CarPlateNumber: 'EV 1',
    CarType: 'Electric',
    PlannedParkingDurationInMinutes: '2',
    Signature: null,
  };
  assert.equal(events.process({ ...base, EventId: 'a', SequenceId: 1, SpotName: 'S1', SpotType: 'Park', Direction: 'CarIn', ServerDateTime: '2026-09-19 10:00:00' }).status, 202);
  assert.equal(events.process({ ...base, EventId: 'b', SequenceId: 2, SpotName: 'S1', SpotType: 'Park', Direction: 'CarOut', ServerDateTime: '2026-09-19 10:03:01' }).status, 202);
  assert.equal(events.process({ ...base, EventId: 'b', SequenceId: 2, SpotName: 'S1', SpotType: 'Park', Direction: 'CarOut', ServerDateTime: '2026-09-19 10:03:01' }).duplicate, true);

  // Billing follows the simulator's declared duration, not wall-clock time: the
  // simulator compresses a parking minute into about ten real seconds, so real
  // minutes would round every stay down to the 1 unit minimum.
  const quote = events.quoteForCar('EV 1');
  assert.equal(quote.parkedMinutes, 2);
  assert.equal(quote.parkingCost, 2);
  assert.equal(quote.chargingCost, 4);

  // With no declared duration, real seconds are converted at that same rate.
  database.upsertCar('EV 1', { planned_minutes: null });
  const derived = events.quoteForCar('EV 1');
  assert.equal(derived.parkedMinutes, 19); // 181 real seconds / 10 per minute.
  assert.equal(derived.parkingCost, 19);
  assert.equal(database.listEvents({ limit: 10 }).length, 2);
  assert.deepEqual(database.getComponent('parking_spot', 'S1').detectedCars, []);
  database.close();
});

test('admits one car per gate cycle, closes the entry gate, and holds when full', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-dispatch-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const calls = [];
  const simulator = {
    async openBarrier(name) { calls.push({ open: name }); return { status: 201, body: null }; },
    async closeBarrier(name) { calls.push({ close: name }); return { status: 201, body: null }; },
    async moveCar(plate, destination) { calls.push({ plate, destination }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0, entryGateName: 'gate0',
  });
  events.storeSync({
    parkingSpots: [
      { name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: [], broken: false, isUnderMaintenance: false },
      { name: 'S2', purpose: 'Park', parkingForCarType: 'Electric', zoneParent: 'Z1', detectedCars: [], broken: false, isUnderMaintenance: false },
      { name: 'S3', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: [], broken: true, isUnderMaintenance: false },
    ],
    barriers: [
      { name: 'gate0', zoneParent: '', state: 'Closed', broken: false, isUnderMaintenance: false },
      { name: 'gateZ1', zoneParent: 'Z1', state: 'Closed', broken: false, isUnderMaintenance: false },
      { name: 'gateZ9', zoneParent: 'Z9', state: 'Closed', broken: false, isUnderMaintenance: false },
    ],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });

  const arrival = (plate, carType, id, sequence, at) => ({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence,
    CarPlateNumber: plate, CarType: carType, SpotName: 'ENTRY1', SpotType: 'EntrySpot',
    Direction: 'CarIn', PlannedParkingDurationInMinutes: '3', Signature: null, ServerDateTime: at,
  });

  // Arrivals are admitted one at a time and a broken spot is skipped.
  events.process(arrival('AAA 111', 'Normal', 'e1', 1, '2026-09-19 10:00:00'));
  events.process(arrival('EV 222', 'Electric', 'e2', 2, '2026-09-19 10:00:05'));
  events.process(arrival('CCC 333', 'Normal', 'e3', 3, '2026-09-19 10:00:09'));
  const first = await events.runDispatch();

  assert.deepEqual(first.assigned, [{ plate: 'AAA 111', spot: 'S1' }]);
  assert.equal(first.waiting, 2);
  assert.deepEqual(calls, [
    { open: 'gate0' }, { plate: 'AAA 111', destination: 'S1' },
  ]);
  assert.equal(database.getCar('AAA 111').status, 'assigned');

  // Nothing else is assigned until the admitted car clears ENTRY1.
  assert.deepEqual((await events.runDispatch()).assigned, []);
  events.process({
    ...arrival('AAA 111', 'Normal', 'e4', 4, '2026-09-19 10:00:10'),
    Direction: 'CarOut',
  });
  assert.deepEqual((await events.runDispatch()).assigned, []);
  assert.deepEqual(calls.at(-1), { close: 'gate0' });

  // The Closed notification starts the next single-car cycle.
  events.process({
    EventClass: 'gate_action', EventId: 'e5', SequenceId: 5, Name: 'gate0', Action: 'Closed',
    Signature: null, ServerDateTime: '2026-09-19 10:00:11',
  });
  const second = await events.runDispatch();
  assert.deepEqual(second.assigned, [{ plate: 'EV 222', spot: 'S2' }]);
  assert.deepEqual(calls.slice(-2), [
    { open: 'gate0' }, { plate: 'EV 222', destination: 'S2' },
  ]);
  assert.equal(database.getCar('CCC 333').assigned_spot, null);

  // A departure frees S1. The queued car receives it after EV clears the entry
  // and the gate completes another close cycle.
  events.process({
    EventClass: 'car_spot_action', EventId: 'e6', SequenceId: 6, CarPlateNumber: 'AAA 111',
    CarType: 'Normal', SpotName: 'S1', SpotType: 'Park', Direction: 'CarOut',
    Signature: null, ServerDateTime: '2026-09-19 10:05:00',
  });
  events.process({
    ...arrival('EV 222', 'Electric', 'e7', 7, '2026-09-19 10:05:01'),
    Direction: 'CarOut',
  });
  await events.runDispatch();
  events.process({
    EventClass: 'gate_action', EventId: 'e8', SequenceId: 8, Name: 'gate0', Action: 'Closed',
    Signature: null, ServerDateTime: '2026-09-19 10:05:02',
  });
  const third = await events.runDispatch();
  assert.deepEqual(third.assigned, [{ plate: 'CCC 333', spot: 'S1' }]);
  assert.equal(third.waiting, 0);
  database.close();
});

test('dispatch is inert without a simulator client', async () => {
  const { events } = fixture();
  const result = await events.runDispatch();
  assert.equal(result.enabled, false);
  assert.deepEqual(result.assigned, []);
});

test('charges cars once they reach an exit spot and records the payment', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-exit-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const charges = [];
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar(plate, parkingCost, chargingCost) {
      charges.push({ plate, parkingCost, chargingCost });
      return { status: 201, body: null };
    },
  };
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0 });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: [], broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });

  const event = (id, sequence, spot, spotType, direction, at, carType = 'Electric') => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence,
    CarPlateNumber: 'EV 9', CarType: carType, SpotName: spot, SpotType: spotType,
    Direction: direction, PlannedParkingDurationInMinutes: '3', Signature: null, ServerDateTime: at,
  });

  event('x1', 1, 'S1', 'Park', 'CarIn', '2026-09-19 10:00:00');
  event('x2', 2, 'S1', 'Park', 'CarOut', '2026-09-19 10:03:01');
  event('x3', 3, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '2026-09-19 10:04:00');

  const result = await events.runDispatch();
  // 3 declared minutes; the Electric surcharge doubles it.
  assert.deepEqual(charges, [{ plate: 'EV 9', parkingCost: 3, chargingCost: 6 }]);
  assert.deepEqual(result.exits.charged, [{ plate: 'EV 9', parkingCost: 3, chargingCost: 6 }]);
  assert.equal(database.getCar('EV 9').payment_status, 'requested');

  // A second pass must not double-charge.
  const again = await events.runDispatch();
  assert.equal(charges.length, 1);
  assert.deepEqual(again.exits.charged, []);

  // The simulator confirms payment, then releases the car itself.
  events.process({
    EventClass: 'payment_made', EventId: 'x4', SequenceId: 4, CarPlateNumber: 'EV 9',
    Amount: 9, Signature: null, ServerDateTime: '2026-09-19 10:04:05',
  });
  assert.equal(database.getCar('EV 9').payment_status, 'received');
  assert.equal(database.getCar('EV 9').paid_amount, 9);
  database.close();
});

test('recovers from phantom state by releasing stale reservations and re-syncing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-recover-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  let syncCount = 0;
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
    async syncAll() {
      syncCount += 1;
      // The simulator's truth: both spots are actually empty.
      return {
        parkingSpots: [
          { name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
          { name: 'S2', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
        ],
        barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
      };
    },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0, staleAssignmentMs: 1000,
  });

  // Cached state wrongly believes both spots are full.
  events.storeSync({
    parkingSpots: [
      { name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: ['GHOST 1'], broken: false, isUnderMaintenance: false },
      { name: 'S2', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: ['GHOST 2'], broken: false, isUnderMaintenance: false },
    ],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  // A real car is queued, and a stale reservation is held by a car that never arrived.
  database.upsertCar('NEW 1', { status: 'waiting_entry', car_type: 'Normal', entered_at: '2026-09-19 10:00:00' });
  database.upsertCar('GONE 1', { status: 'assigned', car_type: 'Normal', assigned_spot: 'S1' });
  database.db.prepare("UPDATE cars SET updated_at = '2020-01-01T00:00:00.000Z' WHERE plate = 'GONE 1'").run();

  assert.equal(database.findAvailableSpot('Normal'), null); // Fully wedged.

  const result = await events.runDispatch();
  assert.equal(syncCount, 1); // Detected the stall and refreshed from the simulator.
  assert.deepEqual(result.released, [{ plate: 'GONE 1', spot: 'S1' }]);
  assert.equal(result.reconciled.freeAfter, 2);
  assert.ok(result.assigned.some((entry) => entry.plate === 'NEW 1'));

  // Rate limiting stops a second sync straight away.
  await events.runDispatch();
  assert.equal(syncCount, 1);
  database.close();
});

test('closes every operable barrier on startup and reopens only what a car needs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-gates-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const calls = [];
  const simulator = {
    async closeBarrier(name) { calls.push({ close: name }); return { status: 201, body: null }; },
    async openBarrier(name) { calls.push({ open: name }); return { status: 201, body: null }; },
    async moveCar(plate, destination) { calls.push({ plate, destination }); return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
  };
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0 });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [
      { name: 'gateA', zoneParent: 'Z1', state: 'Open', broken: false, isUnderMaintenance: false },
      { name: 'gateB', zoneParent: 'Z1', state: 'Open', broken: false, isUnderMaintenance: false },
      { name: 'gateC', zoneParent: '', state: 'Open', broken: false, isUnderMaintenance: false },
      { name: 'gateD', zoneParent: 'Z9', state: 'Open', broken: true, isUnderMaintenance: false },
    ],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });

  const startup = await events.closeAllBarriers();
  assert.deepEqual(startup.closed, ['gateA', 'gateB', 'gateC']);
  assert.deepEqual(startup.failed, [{ name: 'gateD', error: 'broken or under maintenance' }]);
  assert.equal(database.getComponent('barrier', 'gateA').state, 'Closed');
  assert.deepEqual(calls, [{ close: 'gateA' }, { close: 'gateB' }, { close: 'gateC' }]);

  // A car arriving reopens the perimeter gate and both Z1 gates, but not the broken one.
  calls.length = 0;
  events.process({
    EventClass: 'car_spot_action', EventId: 'g1', SequenceId: 1, CarPlateNumber: 'AAA 111',
    CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarIn',
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: '2026-09-19 10:00:00',
  });
  await events.runDispatch();
  assert.deepEqual(calls, [
    { open: 'gateA' }, { open: 'gateB' }, { open: 'gateC' },
    { plate: 'AAA 111', destination: 'S1' },
  ]);
  database.close();
});

test('does not leak a reservation when a car re-triggers an entry event', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-leak-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
  };
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0 });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  const arrival = (id, sequence) => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence, CarPlateNumber: 'AAA 111',
    CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarIn',
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: '2026-09-19 10:00:00',
  });

  arrival('n1', 1);
  await events.runDispatch();
  assert.equal(database.getCar('AAA 111').assigned_spot, 'S1');

  // The same car appears at the entrance again: its reservation must be dropped,
  // not carried while the car is marked as queueing.
  arrival('n2', 2);
  assert.equal(database.getCar('AAA 111').assigned_spot, null);
  assert.equal(database.findAvailableSpot('Normal').name, 'S1');

  // A reservation left behind by any other means is released, not held forever.
  database.upsertCar('AAA 111', { status: 'waiting_entry', assigned_spot: 'S1' });
  assert.equal(database.findAvailableSpot('Normal'), null);
  const result = await events.runDispatch();
  assert.ok(result.released.some((entry) => entry.plate === 'AAA 111' && entry.spot === 'S1'));
  database.close();
});

test('turns cars away once the park is full instead of letting the entrance gridlock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-full-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const moves = [];
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
    async moveCar(plate, destination) { moves.push({ plate, destination }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0, maxEntryQueue: 1,
  });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });

  // Four cars arrive, one spot exists.
  ['A 1', 'B 2', 'C 3', 'D 4'].forEach((plate, index) => events.process({
    EventClass: 'car_spot_action', EventId: `f${index}`, SequenceId: index + 1, CarPlateNumber: plate,
    CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarIn',
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: `2026-09-19 10:00:0${index}`,
  }));

  const result = await events.runDispatch();
  assert.deepEqual(result.assigned, [{ plate: 'A 1', spot: 'S1' }]);
  // One car may wait (maxEntryQueue), the rest are sent to an escape route.
  assert.deepEqual(result.rejected, ['C 3', 'D 4']);
  assert.deepEqual(moves.filter((m) => m.destination === 'leavepark').map((m) => m.plate), ['C 3', 'D 4']);
  assert.equal(database.getCar('D 4').status, 'turned_away');
  assert.equal(database.getCar('B 2').status, 'waiting_entry');
  database.close();
});

test('resetCarState clears phantom cars and their reservations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-reset-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  database.upsertCar('OLD 1', { status: 'assigned', assigned_spot: 'S1' });
  database.setMetadata('last_sequence_id', '1215');
  assert.equal(database.resetCarState(), 1);
  assert.equal(database.getCar('OLD 1'), null);
  assert.equal(database.getMetadata('last_sequence_id'), null);
  database.close();
});

test('overlapping dispatch passes never charge a car twice', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-race-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const charges = [];
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar(plate, parkingCost) {
      charges.push({ plate, parkingCost });
      await new Promise((resolve) => { setTimeout(resolve, 20); }); // Slow simulator.
      return { status: 201, body: null };
    },
  };
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0 });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  const event = (id, sequence, spot, spotType, direction, at) => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence, CarPlateNumber: 'EV 9',
    CarType: 'Normal', SpotName: spot, SpotType: spotType, Direction: direction,
    PlannedParkingDurationInMinutes: '3', Signature: null, ServerDateTime: at,
  });
  event('r1', 1, 'S1', 'Park', 'CarIn', '2026-09-19 10:00:00');
  event('r2', 2, 'S1', 'Park', 'CarOut', '2026-09-19 10:03:01');
  event('r3', 3, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '2026-09-19 10:04:00');

  // A webhook and the heartbeat firing together.
  const [first, second] = await Promise.all([events.runDispatch(), events.runDispatch()]);

  assert.equal(charges.length, 1, 'the car must be charged exactly once');
  assert.ok(first.deferred || second.deferred, 'one pass must defer to the other');
  database.close();
});

test('never ejects cars before the level has been discovered', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-notready-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const moves = [];
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
    async syncAll() {
      return {
        parkingSpots: [
          { name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
          { name: 'S2', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
        ],
        barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
      };
    },
    async moveCar(plate, destination) { moves.push({ plate, destination }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0, maxEntryQueue: 1,
  });

  // Webhooks arrive while bootstrap is still waiting for a level to load.
  ['A 1', 'B 2', 'C 3', 'D 4'].forEach((plate, index) => events.process({
    EventClass: 'car_spot_action', EventId: `n${index}`, SequenceId: index + 1, CarPlateNumber: plate,
    CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarIn',
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: `2026-09-19 10:00:0${index}`,
  }));

  const early = await events.runDispatch();
  assert.equal(early.notReady, true);
  assert.equal(early.waiting, 4, 'the cars are kept, not discarded');
  assert.deepEqual(moves, [], 'no car may be sent anywhere yet');

  // The level loads; the queued cars are now placed rather than ejected.
  events.storeSync(await simulator.syncAll());
  const after = await events.runDispatch();
  assert.deepEqual(after.assigned.map((entry) => entry.spot), ['S1', 'S2']);
  assert.deepEqual(moves.filter((m) => m.destination === 'leavepark').map((m) => m.plate), ['D 4']);
  database.close();
});

test('a gate stuck in Closing cannot deadlock the entrance forever', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-closing-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const moves = [];
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async closeBarrier() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
    async moveCar(plate, destination) { moves.push({ plate, destination }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0,
    entryGateName: 'gateA', gateCloseTimeoutMs: 5000,
  });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [{ name: 'gateA', zoneParent: 'Z1', state: 'Open', broken: false, isUnderMaintenance: false }],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  events.process({
    EventClass: 'car_spot_action', EventId: 'c1', SequenceId: 1, CarPlateNumber: 'AAA 111',
    CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarIn',
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: '2026-09-19 10:00:00',
  });

  // First pass closes the open gate and admits nobody yet.
  await events.runDispatch();
  assert.equal(database.getComponent('barrier', 'gateA').state, 'Closing');
  assert.deepEqual(moves, []);

  // The confirming gate_action never arrives, as this simulator build often
  // drops webhooks. Before the timeout the entrance correctly stays shut.
  assert.equal(events.entryGateIsClosed(), false);
  await events.runDispatch();
  assert.deepEqual(moves, [], 'still waiting for the gate');

  // Past the timeout the car is admitted instead of waiting forever.
  const later = Date.now() + 6000;
  assert.equal(events.entryGateIsClosed(later), true);
  const gate = database.getComponent('barrier', 'gateA');
  database.upsertComponent('barrier', { ...gate, closingAt: Date.now() - 6000 });
  await events.runDispatch();
  assert.deepEqual(moves, [{ plate: 'AAA 111', destination: 'S1' }]);
  database.close();
});

test('the exit barrier stays shut until the car has paid', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-exitgate-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const gates = [];
  const simulator = {
    async openBarrier(name) { gates.push({ open: name }); return { status: 201, body: null }; },
    async closeBarrier(name) { gates.push({ close: name }); return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0,
    entryGateName: 'gateA', exitGateName: 'gateB', paymentConfirmTimeoutMs: 0,
  });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [
      { name: 'gateA', zoneParent: 'Z1', state: 'Closed', broken: false, isUnderMaintenance: false },
      { name: 'gateB', zoneParent: 'Z1', state: 'Open', broken: false, isUnderMaintenance: false },
    ],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  const event = (id, sequence, spot, spotType, direction, at) => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence, CarPlateNumber: 'AAA 111',
    CarType: 'Normal', SpotName: spot, SpotType: spotType, Direction: direction,
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: at,
  });

  // Nobody has paid, so the exit barrier is shut.
  await events.runDispatch();
  assert.deepEqual(gates, [{ close: 'gateB' }]);
  // The simulator confirms the close, as it does with a real gate_action event.
  const confirmClosed = (id, sequence) => events.process({
    EventClass: 'gate_action', EventId: id, SequenceId: sequence,
    Name: 'gateB', Action: 'Closed', Signature: null, ServerDateTime: '2026-09-19 10:00:01',
  });
  confirmClosed('g0', 90);

  // The car reaches the exit and is charged, but has not paid yet.
  gates.length = 0;
  event('e1', 1, 'S1', 'Park', 'CarIn', '2026-09-19 10:00:00');
  event('e2', 2, 'S1', 'Park', 'CarOut', '2026-09-19 10:00:21');
  event('e3', 3, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '2026-09-19 10:00:25');
  await events.runDispatch();
  assert.equal(database.getCar('AAA 111').payment_status, 'requested');
  assert.deepEqual(gates.filter((g) => g.open === 'gateB'), [], 'charged is not paid');

  // Payment confirmed: only now does the barrier open.
  gates.length = 0;
  events.process({
    EventClass: 'payment_made', EventId: 'e4', SequenceId: 4, CarPlateNumber: 'AAA 111',
    Amount: 2, Signature: null, ServerDateTime: '2026-09-19 10:00:28',
  });
  await events.runDispatch();
  assert.deepEqual(gates, [{ open: 'gateB' }]);

  // Once the car has gone, the barrier shuts behind it so no unpaid car follows.
  gates.length = 0;
  event('e5', 5, 'EXIT_EXIT', 'ExitSpot', 'CarOut', '2026-09-19 10:00:30');
  await events.runDispatch();
  assert.deepEqual(gates, [{ close: 'gateB' }]);
  assert.equal(events.releasingPlate, null, 'the released car is no longer tracked');
  database.close();
});

test('a car is released when the payment webhook never arrives', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-nopay-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const gates = [];
  const simulator = {
    async openBarrier(name) { gates.push({ open: name }); return { status: 201, body: null }; },
    async closeBarrier(name) { gates.push({ close: name }); return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
  };
  // This build delivers payment_made for roughly a quarter of charges, so a
  // charged car must not be trapped waiting for a webhook that never comes.
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0,
    exitGateName: 'gateB', paymentConfirmTimeoutMs: 1,
  });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [{ name: 'gateB', zoneParent: 'Z1', state: 'Closed', broken: false, isUnderMaintenance: false }],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  const event = (id, sequence, spot, spotType, direction, at) => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence, CarPlateNumber: 'BBB 222',
    CarType: 'Normal', SpotName: spot, SpotType: spotType, Direction: direction,
    PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: at,
  });
  event('p1', 1, 'S1', 'Park', 'CarIn', '2026-09-19 10:00:00');
  event('p2', 2, 'S1', 'Park', 'CarOut', '2026-09-19 10:00:21');
  event('p3', 3, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '2026-09-19 10:00:25');

  await events.runDispatch();          // charges the car
  gates.length = 0;
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await events.runDispatch();          // timeout elapsed, so release it
  assert.deepEqual(gates, [{ open: 'gateB' }]);
  assert.equal(database.getCar('BBB 222').payment_status, 'requested', 'still unconfirmed');
  database.close();
});

test('route barriers are opened so the simulator can path, entry and exit are not', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-route-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const gates = [];
  const simulator = {
    async openBarrier(name) { gates.push({ open: name }); return { status: 201, body: null }; },
    async closeBarrier(name) { gates.push({ close: name }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0,
    entryGateName: 'gateA', exitGateName: 'gateB',
  });
  events.storeSync({
    parkingSpots: [], lights: [], exhaustFans: [], alarms: [], zones: [],
    barriers: [
      { name: 'gateA', zoneParent: 'Z1', state: 'Closed', broken: false, isUnderMaintenance: false },
      { name: 'gateB', zoneParent: 'Z1', state: 'Closed', broken: false, isUnderMaintenance: false },
      { name: 'gateC', zoneParent: '', state: 'Closed', broken: false, isUnderMaintenance: false },
      { name: 'gateD', zoneParent: 'Z1', state: 'Closed', broken: true, isUnderMaintenance: false },
    ],
  });

  const result = await events.openRouteBarriers();
  // Level 1 topology: gateC is the street gate at the car emitter, gateA is the
  // way into the park, gateB is the exit. Only gateC is a route barrier here;
  // gateA and gateB are managed, and gateD is broken.
  assert.deepEqual(result.opened, ['gateC']);
  assert.deepEqual(gates, [{ open: 'gateC' }]);
  assert.equal(database.getComponent('barrier', 'gateC').state, 'Open');
  assert.equal(database.getComponent('barrier', 'gateA').state, 'Closed');
  assert.equal(database.getComponent('barrier', 'gateB').state, 'Closed');
  database.close();
});

test('the declared parking duration survives the zero on exit events', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-planned-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0 });
  const event = (id, sequence, spot, spotType, direction, planned, at) => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: sequence, CarPlateNumber: 'AAA 111',
    CarType: 'Normal', SpotName: spot, SpotType: spotType, Direction: direction,
    PlannedParkingDurationInMinutes: planned, Signature: null, ServerDateTime: at,
  });

  event('d1', 1, 'ENTRY1', 'EntrySpot', 'CarIn', '3', '2026-09-19 10:00:00');
  assert.equal(database.getCar('AAA 111').planned_minutes, 3);

  event('d2', 2, 'S1', 'Park', 'CarIn', '3', '2026-09-19 10:00:05');
  event('d3', 3, 'S1', 'Park', 'CarOut', '3', '2026-09-19 10:00:36');
  // The simulator sends "0" on exit events; that must not erase the real value,
  // or every car would fall back to the minimum fare.
  event('d4', 4, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '0', '2026-09-19 10:00:40');
  assert.equal(database.getCar('AAA 111').planned_minutes, 3);

  const quote = events.quoteForCar('AAA 111');
  assert.equal(quote.parkingCost, 3, 'billed on the declared duration, not the zero');
  database.close();
});

test('cars that slipped inside are given spots without waiting for the gate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-inside-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const calls = [];
  const simulator = {
    async openBarrier(name) { calls.push({ open: name }); return { status: 201, body: null }; },
    async closeBarrier(name) { calls.push({ close: name }); return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
    async moveCar(plate, destination) { calls.push({ plate, destination }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0, entryGateName: 'gateA',
  });
  events.storeSync({
    parkingSpots: [
      { name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
      { name: 'S2', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
    ],
    barriers: [{ name: 'gateA', zoneParent: 'Z1', state: 'Open', broken: false, isUnderMaintenance: false }],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });

  // Two cars drove through the open gate without ever being assigned a spot.
  ['A 1', 'B 2'].forEach((plate, i) => {
    events.process({
      EventClass: 'car_spot_action', EventId: `i${i}a`, SequenceId: i * 2 + 1, CarPlateNumber: plate,
      CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarIn',
      PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: `2026-09-19 10:00:0${i}`,
    });
    events.process({
      EventClass: 'car_spot_action', EventId: `i${i}b`, SequenceId: i * 2 + 2, CarPlateNumber: plate,
      CarType: 'Normal', SpotName: 'ENTRY1', SpotType: 'EntrySpot', Direction: 'CarOut',
      PlannedParkingDurationInMinutes: '2', Signature: null, ServerDateTime: `2026-09-19 10:00:0${i}`,
    });
  });
  assert.equal(database.getCar('A 1').status, 'inside');

  const result = await events.runDispatch();
  assert.deepEqual(result.assigned, [{ plate: 'A 1', spot: 'S1' }, { plate: 'B 2', spot: 'S2' }]);
  // They are already past the barrier, so no gate command is issued for them.
  assert.deepEqual(calls.filter((c) => c.open || c.close), []);
  database.close();
});

test('a stale assignment stops blocking the entry cycle', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-stuckentry-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, entryGateName: 'gateA', staleAssignmentMs: 1000,
  });
  database.upsertCar('STUCK 1', { status: 'assigned', assigned_spot: 'S1', car_type: 'Normal' });

  // Freshly assigned: genuinely still driving in, so it holds the cycle.
  assert.ok(events.carAwaitingEntry());
  // Long stale: it must release the cycle, or no other car is ever admitted and
  // the gate never closes.
  assert.equal(events.carAwaitingEntry(Date.now() + 5000), null);
  database.close();
});

test('a charge whose payment never confirms is retried, then given up on', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-recharge-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const charges = [];
  const simulator = {
    async chargeCar(plate, parkingCost) { charges.push({ plate, parkingCost }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, rechargeAfterMs: 1, maxRechargeAttempts: 2,
  });
  database.upsertCar('PAY 1', {
    status: 'at_exit', car_type: 'Normal', planned_minutes: 2,
    parked_at: '2026-09-19 10:00:00', departed_spot_at: '2026-09-19 10:00:21',
    payment_status: 'requested',
  });

  // Each recharge refreshes updated_at, so drive the clock explicitly rather than
  // racing it: a later `now` is what makes the next attempt due.
  const later = (ms) => Date.now() + ms;
  assert.deepEqual((await events.rechargeStalledExits(later(1000))).recharged, [{ plate: 'PAY 1', attempt: 1 }]);
  assert.deepEqual((await events.rechargeStalledExits(later(2000))).recharged, [{ plate: 'PAY 1', attempt: 2 }]);
  // Capped, so a car the simulator will never confirm cannot be charged forever.
  assert.deepEqual((await events.rechargeStalledExits(later(3000))).recharged, []);
  assert.equal(charges.length, 2);
  database.close();
});

test('a returning plate starts a clean journey instead of inheriting the last one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-reuse-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const charges = [];
  const simulator = {
    async openBarrier() { return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
    async chargeCar(plate, parkingCost) { charges.push({ plate, parkingCost }); return { status: 201, body: null }; },
  };
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0 });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  const event = (id, seq, spot, spotType, direction, planned, at) => events.process({
    EventClass: 'car_spot_action', EventId: id, SequenceId: seq, CarPlateNumber: 'RE 1',
    CarType: 'Normal', SpotName: spot, SpotType: spotType, Direction: direction,
    PlannedParkingDurationInMinutes: planned, Signature: null, ServerDateTime: at,
  });

  // First visit, all the way through payment.
  event('r1', 1, 'ENTRY1', 'EntrySpot', 'CarIn', '3', '2026-09-19 10:00:00');
  event('r2', 2, 'S1', 'Park', 'CarIn', '3', '2026-09-19 10:00:05');
  event('r3', 3, 'S1', 'Park', 'CarOut', '3', '2026-09-19 10:00:36');
  event('r4', 4, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '0', '2026-09-19 10:00:40');
  await events.runDispatch();
  events.process({
    EventClass: 'payment_made', EventId: 'r5', SequenceId: 5, CarPlateNumber: 'RE 1',
    Amount: 3, Signature: null, ServerDateTime: '2026-09-19 10:00:41',
  });
  event('r6', 6, 'EXIT_EXIT', 'ExitSpot', 'CarOut', '0', '2026-09-19 10:00:45');
  assert.equal(database.getCar('RE 1').payment_status, 'received');
  assert.equal(charges.length, 1);

  // The same plate returns. Nothing from the first visit may survive, or the car
  // looks already paid and is never charged again.
  event('r7', 7, 'ENTRY1', 'EntrySpot', 'CarIn', '1', '2026-09-19 10:05:00');
  const car = database.getCar('RE 1');
  assert.equal(car.payment_status, 'not_requested');
  assert.equal(car.paid_amount, null);
  assert.equal(car.parked_at, null);
  assert.equal(car.arrived_exit_at, null);
  assert.equal(car.planned_minutes, 1, 'the new declared duration is used');

  // Second visit is charged on its own merits.
  event('r8', 8, 'S1', 'Park', 'CarIn', '1', '2026-09-19 10:05:05');
  event('r9', 9, 'S1', 'Park', 'CarOut', '1', '2026-09-19 10:05:16');
  event('r10', 10, 'EXIT_EXIT', 'ExitSpot', 'CarIn', '0', '2026-09-19 10:05:20');
  await events.runDispatch();
  assert.deepEqual(charges, [{ plate: 'RE 1', parkingCost: 3 }, { plate: 'RE 1', parkingCost: 1 }]);
  database.close();
});

test('resetHistory clears the audit trail but keeps the discovered level', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-history-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const events = new EventService(database, { requireWebhookSignature: false, chargeDelayMs: 0 });
  events.storeSync({
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false }],
    barriers: [], lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  events.process({
    EventClass: 'penalty', EventId: 'h1', SequenceId: 1, Reason: 'Car should be charged at the exit.',
    FineAmount: '10', ComponentName: 'AAA 111', Signature: null, ServerDateTime: '2026-09-19 10:00:00',
  });
  database.createCommand('auto.car.assign', 'AAA 111:S1', 'auto-dispatch');
  assert.equal(database.listEvents({ limit: 10 }).length, 1);
  assert.equal(database.listCommands(10).length, 1);

  const cleared = database.resetHistory();
  assert.deepEqual(cleared, { events: 1, commands: 1 });
  assert.equal(database.listEvents({ limit: 10 }).length, 0);
  assert.equal(database.listCommands(10).length, 0);
  assert.equal(database.getMetadata('last_sequence_id'), null);
  // The level survives, so no rediscovery is needed.
  assert.equal(database.listComponents('parking_spot').length, 1);
  assert.ok(database.getMetadata('last_sync_at'));
  database.close();
});

test('a car is not charged until it has settled on the exit spot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-settle-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const charges = [];
  const simulator = {
    async chargeCar(plate, parkingCost) { charges.push({ plate, parkingCost }); return { status: 201, body: null }; },
  };
  // Measured against the simulator: a charge sent within ~0.25s of the arrival
  // webhook is silently ignored and earns "Car should be charged at the exit",
  // while one sent after ~1.1s is accepted first time.
  const events = new EventService(database, {
    requireWebhookSignature: false, simulator, chargeDelayMs: 1500,
  });
  database.upsertCar('SET 1', {
    status: 'at_exit', car_type: 'Normal', planned_minutes: 2,
    parked_at: '2026-09-19 10:00:00', departed_spot_at: '2026-09-19 10:00:21',
    payment_status: 'not_requested',
  });

  // Immediately on arrival: too early, so nothing is sent.
  assert.deepEqual((await events.chargeCarsAtExit(Date.now())).charged, []);
  assert.deepEqual(charges, []);
  assert.equal(database.getCar('SET 1').payment_status, 'not_requested');

  // Once settled, it is charged exactly once.
  assert.deepEqual((await events.chargeCarsAtExit(Date.now() + 2000)).charged,
    [{ plate: 'SET 1', parkingCost: 2, chargingCost: 0 }]);
  assert.equal(charges.length, 1);
  assert.deepEqual((await events.chargeCarsAtExit(Date.now() + 4000)).charged, []);
  assert.equal(charges.length, 1, 'never charged twice');
  database.close();
});

test('the exit gate opens for one paid car and never stays open indefinitely', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-release-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const gates = [];
  const simulator = {
    async openBarrier(name) { gates.push({ open: name }); return { status: 201, body: null }; },
    async closeBarrier(name) { gates.push({ close: name }); return { status: 201, body: null }; },
    async chargeCar() { return { status: 201, body: null }; },
    async moveCar() { return { status: 201, body: null }; },
  };
  const events = new EventService(database, {
    requireWebhookSignature: false, chargeDelayMs: 0, simulator, gateSettleMs: 0,
    exitGateName: 'gateB', releaseTimeoutMs: 50, paymentConfirmTimeoutMs: 0,
  });
  events.storeSync({
    // A dispatch pass does nothing until the level is known, so the park needs
    // at least one spot even though this test is about the exit.
    parkingSpots: [{ name: 'S1', purpose: 'Park', parkingForCarType: 'Any', zoneParent: 'Z1', detectedCars: 1, broken: false, isUnderMaintenance: false }],
    barriers: [{ name: 'gateB', zoneParent: 'Z1', state: 'Closed', broken: false, isUnderMaintenance: false }],
    lights: [], exhaustFans: [], alarms: [], zones: [],
  });
  // One paid car ready to leave, one unpaid car also sitting at the exit.
  database.upsertCar('PAID 1', { status: 'at_exit', car_type: 'Normal', payment_status: 'received', paid_amount: 2 });
  database.upsertCar('UNPAID 1', { status: 'at_exit', car_type: 'Normal', payment_status: 'requested' });

  await events.runDispatch();
  assert.deepEqual(gates, [{ open: 'gateB' }], 'opened for the paid car only');
  assert.equal(events.releasingPlate, 'PAID 1');

  // The car never departs. The gate must not stay open, or the unpaid car
  // follows it out and earns "Car escaped without paying".
  gates.length = 0;
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  await events.runDispatch();
  assert.equal(events.releasingPlate, null, 'stopped waiting for the stuck car');
  assert.deepEqual(gates, [{ close: 'gateB' }]);
  database.close();
});
