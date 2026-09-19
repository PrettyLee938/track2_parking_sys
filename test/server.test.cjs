const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ParkingDatabase } = require('../src/database.cjs');
const { EventService } = require('../src/event-service.cjs');
const { createParkingServer } = require('../src/server.cjs');

function authorization(username = 'admin', password = 'admin') {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

test('synchronizes, exposes state, receives webhooks, and assigns a compatible spot', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-server-'));
  const database = new ParkingDatabase(path.join(directory, 'test.db'));
  const events = new EventService(database, { requireWebhookSignature: false });
  const calls = [];
  const simulator = {
    async syncAll() {
      return {
        parkingSpots: [
          { name: 'E1', purpose: 'Park', parkingForCarType: 'Electric', zoneParent: 'Z1', detectedCars: 0, broken: false, isUnderMaintenance: false },
          { name: 'E2', purpose: 'Park', parkingForCarType: 'Electric', zoneParent: 'Z1', detectedCars: 1, broken: false, isUnderMaintenance: false },
        ],
        barriers: [{ name: 'gate0', state: 'Closed', broken: false, isUnderMaintenance: false }],
        lights: [], exhaustFans: [], alarms: [], zones: [{ name: 'Z1', risk: 'Safe', gasCarbonMonoxideLevel: 0 }],
      };
    },
    async moveCar(plate, destination) {
      calls.push({ plate, destination });
      return { status: 201, body: null };
    },
  };
  const config = {
    simulatorBaseUrl: 'http://simulator.invalid',
    adminUsername: 'admin', adminPassword: 'admin',
    operatorUsername: 'operator', operatorPassword: 'operator',
  };
  const server = createParkingServer({ config, database, simulator, events });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(() => { database.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/v1/dashboard`)).status, 401);
  const headers = { authorization: authorization() };
  assert.equal((await fetch(`${base}/api/v1/sync`, { method: 'POST', headers })).status, 200);

  const webhook = {
    EventClass: 'car_spot_action', EventId: 'event-1', SequenceId: 1,
    CarPlateNumber: 'EV 7', CarType: 'Electric', SpotName: 'ENTRY1',
    SpotType: 'EntrySpot', Direction: 'CarIn', PlannedParkingDurationInMinutes: '3',
    Signature: null, ServerDateTime: '2026-09-19 10:00:00',
  };
  assert.equal((await fetch(`${base}/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhook),
  })).status, 202);

  const assignment = await fetch(`${base}/api/v1/cars/EV%207/assign`, { method: 'POST', headers });
  assert.equal(assignment.status, 201);
  assert.deepEqual(calls, [{ plate: 'EV 7', destination: 'E1' }]);
  const dashboard = await (await fetch(`${base}/api/v1/dashboard`, { headers })).json();
  assert.equal(dashboard.parking.free, 1);
  assert.equal(dashboard.parking.occupied, 1);
  assert.equal(dashboard.activeCars, 1);
});
