const http = require('node:http');
const { authenticate } = require('./auth.cjs');
const { SimulatorError } = require('./simulator-client.cjs');
const { isOccupied } = require('./component-state.cjs');

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, { 'cache-control': 'no-store' });
  response.end();
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        const error = new Error('Request body exceeds 1 MiB');
        error.status = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Request body must contain valid JSON');
        error.status = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function limitFrom(url, fallback = 100) {
  const value = Number.parseInt(url.searchParams.get('limit') || '', 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 500) : fallback;
}

function compatibleSpot(carType, spotType) {
  if (spotType === 'Any') return true;
  return carType === spotType;
}

function createParkingServer({ config, database, simulator, events }) {
  async function executeCommand(user, action, target, operation) {
    const commandId = database.createCommand(action, target, user.username);
    try {
      const result = await operation();
      database.completeCommand(commandId, 'completed', result.body);
      return { commandId, simulatorStatus: result.status, result: result.body };
    } catch (error) {
      database.completeCommand(commandId, 'failed', null, error.message);
      throw error;
    }
  }

  function requireKnownComponent(type, name) {
    const component = database.getComponent(type, name);
    if (!component) {
      const error = new Error(`Unknown ${type} ${name}; synchronize state first`);
      error.status = 404;
      throw error;
    }
    return component;
  }

  function requireOperable(component) {
    if (component.broken || component.isUnderMaintenance) {
      const error = new Error(`${component.name} is broken or under maintenance`);
      error.status = 409;
      throw error;
    }
  }

  async function handler(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const path = decodeURIComponent(url.pathname);
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, {
          status: 'ok',
          service: 'grand-park-auto-control-api',
          simulatorBaseUrl: config.simulatorBaseUrl,
          lastSyncAt: database.getMetadata('last_sync_at'),
        });
      }

      if (request.method === 'POST' && (path === '/webhook' || path === '/api/v1/webhooks/simulator')) {
        const result = events.process(await readJson(request));
        sendJson(response, result.status, result.accepted ? { received: true, ...result } : result);
        // Guide cars after the response so the simulator's webhook sender is never blocked.
        if (result.accepted && !result.duplicate) {
          Promise.resolve(events.runDispatch())
            .catch((error) => console.error(`Auto-dispatch failed: ${error.message}`));
        }
        return;
      }

      if (!path.startsWith('/api/v1/')) {
        return sendJson(response, 404, { error: 'Not found' });
      }

      const user = authenticate(request, config);
      if (!user) {
        response.setHeader('www-authenticate', 'Basic realm="Grand Park Auto"');
        return sendJson(response, 401, { error: 'Application authentication required' });
      }

      if (request.method === 'GET' && path === '/api/v1/session') {
        return sendJson(response, 200, user);
      }

      if (request.method === 'POST' && path === '/api/v1/sync') {
        const snapshot = await simulator.syncAll();
        events.storeSync(snapshot);
        return sendJson(response, 200, {
          synchronizedAt: database.getMetadata('last_sync_at'),
          counts: Object.fromEntries(
            Object.entries(snapshot).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
          ),
        });
      }

      if (request.method === 'POST' && path === '/api/v1/simulator/test-webhook') {
        return sendJson(response, 200, await executeCommand(
          user,
          'test_webhook',
          'simulator',
          () => simulator.testWebhook(),
        ));
      }

      if (request.method === 'POST' && path === '/api/v1/reset') {
        const body = await readJson(request);
        const wantsHistory = url.searchParams.get('history') === 'true' || Boolean(body.history);
        const cars = database.resetCarState();
        const history = wantsHistory ? database.resetHistory() : null;
        console.log(`Reset requested by ${user.username}: ${cars} cars${history ? `, ${history.events} events, ${history.commands} commands` : ''}`);
        return sendJson(response, 200, { cars, ...(history ? { history } : {}) });
      }

      if (request.method === 'POST' && path === '/api/v1/dispatch') {
        // Accept ?redrive=true as well as a JSON body; PowerShell mangles inline JSON.
        const options = await readJson(request);
        const redrive = url.searchParams.get('redrive') === 'true' || Boolean(options.redrive);
        return sendJson(response, 200, await events.runDispatch({ redrive }));
      }

      if (request.method === 'GET' && path === '/api/v1/dashboard') {
        return sendJson(response, 200, database.dashboard());
      }

      const listRoutes = {
        '/api/v1/parking-spots': 'parking_spot',
        '/api/v1/barriers': 'barrier',
        '/api/v1/lights': 'light',
        '/api/v1/exhaust-fans': 'exhaust_fan',
        '/api/v1/alarms': 'alarm',
        '/api/v1/zones': 'zone',
      };
      if (request.method === 'GET' && listRoutes[path]) {
        return sendJson(response, 200, database.listComponents(listRoutes[path], {
          zone: url.searchParams.get('zone') || undefined,
          status: url.searchParams.get('status') || undefined,
        }));
      }

      if (request.method === 'GET' && path === '/api/v1/cars') {
        return sendJson(response, 200, database.listCars({
          status: url.searchParams.get('status') || undefined,
          query: url.searchParams.get('q') || undefined,
          limit: limitFrom(url),
        }));
      }

      if (request.method === 'GET' && path === '/api/v1/events') {
        const afterSequence = url.searchParams.has('afterSequence')
          ? Number(url.searchParams.get('afterSequence'))
          : undefined;
        return sendJson(response, 200, database.listEvents({
          eventClass: url.searchParams.get('class') || undefined,
          afterSequence,
          limit: limitFrom(url),
        }));
      }

      if (request.method === 'GET' && path === '/api/v1/penalties') {
        return sendJson(response, 200, database.listEvents({ eventClass: 'penalty', limit: limitFrom(url) }));
      }

      if (request.method === 'GET' && path === '/api/v1/commands') {
        return sendJson(response, 200, database.listCommands(limitFrom(url)));
      }

      let match = path.match(/^\/api\/v1\/cars\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        const car = database.getCar(match[1]);
        return car ? sendJson(response, 200, car) : sendJson(response, 404, { error: 'Car not found' });
      }

      match = path.match(/^\/api\/v1\/cars\/([^/]+)\/quote$/);
      if (request.method === 'GET' && match) {
        const quote = events.quoteForCar(match[1]);
        return quote ? sendJson(response, 200, quote) : sendJson(response, 404, { error: 'Car not found' });
      }

      match = path.match(/^\/api\/v1\/barriers\/([^/]+)\/(open|close|repair)$/);
      if (request.method === 'POST' && match) {
        const [, name, action] = match;
        const barrier = requireKnownComponent('barrier', name);
        if (action !== 'repair') requireOperable(barrier);
        const operation = action === 'open'
          ? () => simulator.openBarrier(name)
          : action === 'close'
            ? () => simulator.closeBarrier(name)
            : () => simulator.repairBarrier(name);
        return sendJson(response, 201, await executeCommand(user, `barrier.${action}`, name, operation));
      }

      match = path.match(/^\/api\/v1\/lights\/([^/]+)\/(on|off)$/);
      if (request.method === 'POST' && match) {
        const [, name, action] = match;
        requireKnownComponent('light', name);
        return sendJson(response, 201, await executeCommand(
          user,
          `light.${action}`,
          name,
          () => simulator.setLight(name, action === 'on'),
        ));
      }

      match = path.match(/^\/api\/v1\/light-groups\/([^/]+)\/(on|off)$/);
      if (request.method === 'POST' && match) {
        const [, name, action] = match;
        return sendJson(response, 201, await executeCommand(
          user,
          `light_group.${action}`,
          name,
          () => simulator.setLightGroup(name, action === 'on'),
        ));
      }

      match = path.match(/^\/api\/v1\/exhaust-fans\/([^/]+)\/(on|off|repair)$/);
      if (request.method === 'POST' && match) {
        const [, name, action] = match;
        const fan = requireKnownComponent('exhaust_fan', name);
        if (action !== 'repair') requireOperable(fan);
        return sendJson(response, 201, await executeCommand(
          user,
          `exhaust_fan.${action}`,
          name,
          () => simulator.setExhaustFan(name, action),
        ));
      }

      match = path.match(/^\/api\/v1\/parking-spots\/([^/]+)\/repair$/);
      if (request.method === 'POST' && match) {
        const spot = requireKnownComponent('parking_spot', match[1]);
        if (isOccupied(spot)) {
          const error = new Error('Cannot repair an occupied parking spot');
          error.status = 409;
          throw error;
        }
        return sendJson(response, 201, await executeCommand(
          user,
          'parking_spot.repair',
          match[1],
          () => simulator.repairParkingSpot(match[1]),
        ));
      }

      match = path.match(/^\/api\/v1\/cars\/([^/]+)\/assign$/);
      if (request.method === 'POST' && match) {
        const car = database.getCar(match[1]);
        if (!car) return sendJson(response, 404, { error: 'Car not found' });
        const spot = database.findAvailableSpot(car.car_type);
        if (!spot) return sendJson(response, 409, { error: 'No compatible free parking spot is available' });
        const result = await executeCommand(
          user,
          'car.assign',
          `${car.plate}:${spot.name}`,
          () => simulator.moveCar(car.plate, spot.name),
        );
        database.upsertCar(car.plate, { assigned_spot: spot.name, status: 'assigned' });
        return sendJson(response, 201, { ...result, assignedSpot: spot });
      }

      match = path.match(/^\/api\/v1\/cars\/([^/]+)\/goto\/([^/]+)$/);
      if (request.method === 'POST' && match) {
        const [, plate, destination] = match;
        const car = database.getCar(plate);
        if (!car) return sendJson(response, 404, { error: 'Car not found' });
        if (!['exit', 'leavepark'].includes(destination)) {
          const spot = requireKnownComponent('parking_spot', destination);
          requireOperable(spot);
          if (isOccupied(spot)) {
            const error = new Error('Destination parking spot is occupied');
            error.status = 409;
            throw error;
          }
          if (!compatibleSpot(car.car_type, spot.parkingForCarType)) {
            const error = new Error(`Parking spot type ${spot.parkingForCarType} is incompatible with ${car.car_type}`);
            error.status = 409;
            throw error;
          }
          database.upsertCar(plate, { assigned_spot: destination, status: 'assigned' });
        }
        return sendJson(response, 201, await executeCommand(
          user,
          'car.goto',
          `${plate}:${destination}`,
          () => simulator.moveCar(plate, destination),
        ));
      }

      match = path.match(/^\/api\/v1\/cars\/([^/]+)\/charge$/);
      if (request.method === 'POST' && match) {
        const plate = match[1];
        const car = database.getCar(plate);
        if (!car) return sendJson(response, 404, { error: 'Car not found' });
        if (car.status !== 'at_exit') return sendJson(response, 409, { error: 'Car must be at an exit spot before charging' });
        if (car.payment_status !== 'not_requested') {
          return sendJson(response, 409, { error: `Payment is already ${car.payment_status}` });
        }
        const quote = events.quoteForCar(plate);
        if (!quote?.available) return sendJson(response, 409, { error: quote?.reason || 'Cannot calculate charge' });
        const body = await readJson(request);
        const parkingCost = body.parkingCost === undefined ? quote.parkingCost : Number(body.parkingCost);
        const chargingCost = body.chargingCost === undefined ? quote.chargingCost : Number(body.chargingCost);
        if (!Number.isFinite(parkingCost) || !Number.isFinite(chargingCost) || parkingCost < 0 || chargingCost < 0) {
          return sendJson(response, 400, { error: 'parkingCost and chargingCost must be non-negative numbers' });
        }
        if (!body.force && (parkingCost !== quote.parkingCost || chargingCost !== quote.chargingCost)) {
          return sendJson(response, 409, { error: 'Charge differs from calculated quote', quote });
        }
        const result = await executeCommand(
          user,
          'car.charge',
          plate,
          () => simulator.chargeCar(plate, parkingCost, chargingCost),
        );
        database.upsertCar(plate, { payment_status: 'requested' });
        return sendJson(response, 201, { ...result, parkingCost, chargingCost });
      }

      match = path.match(/^\/api\/v1\/cars\/([^/]+)\/leave$/);
      if (request.method === 'POST' && match) {
        const plate = match[1];
        const car = database.getCar(plate);
        if (!car) return sendJson(response, 404, { error: 'Car not found' });
        const quote = events.quoteForCar(plate);
        if (car.payment_status !== 'received' || !quote?.available || car.paid_amount !== quote.totalCost) {
          return sendJson(response, 409, {
            error: 'A matching payment must be received before the car can leave',
            paidAmount: car.paid_amount,
            expectedAmount: quote?.totalCost ?? null,
          });
        }
        const result = await executeCommand(
          user,
          'car.leave',
          plate,
          () => simulator.moveCar(plate, 'leavepark'),
        );
        database.upsertCar(plate, { payment_status: 'verified', status: 'leaving' });
        return sendJson(response, 201, result);
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status || (error instanceof SimulatorError ? error.status : 500);
      return sendJson(response, status, {
        error: error.message || 'Internal server error',
        ...(error.details ? { details: error.details } : {}),
      });
    }
  }

  return http.createServer(handler);
}

module.exports = { createParkingServer, readJson, sendJson };
