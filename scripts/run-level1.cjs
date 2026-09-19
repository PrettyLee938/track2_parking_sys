const baseUrl = process.env.CONTROL_API_URL || 'http://127.0.0.1:8080/api/v1';
const username = process.env.APP_ADMIN_USERNAME || 'admin';
const password = process.env.APP_ADMIN_PASSWORD || 'admin';
const maxCars = Number(process.env.LEVEL1_MAX_CARS || 30);
const durationMinutes = Number(process.env.LEVEL1_DURATION_MINUTES || 20);
const pollMilliseconds = 1000;
const sessionStartedAt = Date.now() - 30_000;
const stopAt = Date.now() + durationMinutes * 60_000;
const tracked = new Set();
const actionInFlight = new Set();
const completed = new Set();
const sentToExit = new Set();
let entryPlate = null;

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function encode(value) {
  return encodeURIComponent(String(value));
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const error = new Error(body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function act(key, description, operation) {
  if (actionInFlight.has(key)) return null;
  actionInFlight.add(key);
  try {
    const result = await operation();
    log(`${description}${result?.commandId ? ` (command ${result.commandId})` : ''}`);
    return result;
  } catch (error) {
    if (error.status !== 409 && error.status !== 404) {
      log(`${description} failed: ${error.message}`);
    }
    return null;
  } finally {
    actionInFlight.delete(key);
  }
}

function parkingDue(car) {
  if (!car.parked_at) return false;
  const parkedAt = new Date(String(car.parked_at).replace(' ', 'T')).valueOf();
  if (!Number.isFinite(parkedAt)) return false;
  return Date.now() >= parkedAt + Math.max(1, Number(car.planned_minutes) || 1) * 60_000;
}

async function discoverSessionCars() {
  const events = await request('/events?limit=500');
  for (const event of events) {
    if (event.eventClass !== 'car_spot_action') continue;
    if (event.payload?.SpotType !== 'EntrySpot' || event.payload?.Direction !== 'CarIn') continue;
    const receivedAt = new Date(event.receivedAt).valueOf();
    if (receivedAt >= sessionStartedAt && event.payload?.CarPlateNumber) {
      tracked.add(event.payload.CarPlateNumber);
    }
  }
}

async function getTrackedCars() {
  const cars = [];
  for (const plate of tracked) {
    try {
      cars.push(await request(`/cars/${encode(plate)}`));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return cars;
}

async function manageEntry(cars, dashboard) {
  const gate = dashboard.barriers.find((item) => item.name === 'gateA');
  if (!gate) throw new Error('Level 1 entry gate gateA was not discovered');

  if (entryPlate) {
    const active = cars.find((car) => car.plate === entryPlate);
    if (!active || !['waiting_entry', 'assigned'].includes(active.status)) {
      if (gate.state === 'Open') {
        await act('gateA.close', 'Closed entry gate gateA', () => request('/barriers/gateA/close', { method: 'POST' }));
      }
      if (gate.state === 'Closed' || !active || active.status === 'parked' || active.status === 'inside') {
        entryPlate = null;
      }
    }
    return;
  }

  if (gate.state !== 'Closed') return;
  const waiting = cars
    .filter((car) => car.status === 'waiting_entry')
    .sort((left, right) => String(left.entered_at).localeCompare(String(right.entered_at)))[0];
  if (!waiting) return;

  const assignment = await act(
    `assign:${waiting.plate}`,
    `Assigned ${waiting.plate}`,
    () => request(`/cars/${encode(waiting.plate)}/assign`, { method: 'POST' }),
  );
  if (!assignment) return;
  entryPlate = waiting.plate;
  log(`${waiting.plate} is going to ${assignment.assignedSpot?.name || 'its assigned spot'}`);
  await act('gateA.open', 'Opened entry gate gateA', () => request('/barriers/gateA/open', { method: 'POST' }));
}

async function manageCar(car) {
  if (car.status === 'parked' && parkingDue(car) && !sentToExit.has(car.plate)) {
    const result = await act(
      `exit:${car.plate}`,
      `Sent ${car.plate} to the payment exit`,
      () => request(`/cars/${encode(car.plate)}/goto/exit`, { method: 'POST' }),
    );
    if (result) sentToExit.add(car.plate);
    return;
  }

  if (car.status === 'at_exit' && car.payment_status === 'not_requested') {
    await act(
      `charge:${car.plate}`,
      `Requested the calculated payment from ${car.plate}`,
      () => request(`/cars/${encode(car.plate)}/charge`, { method: 'POST', body: '{}' }),
    );
    return;
  }

  if (car.status === 'at_exit' && car.payment_status === 'received') {
    const quote = await request(`/cars/${encode(car.plate)}/quote`);
    if (!quote.available || car.paid_amount !== quote.totalCost) {
      log(`Held ${car.plate}: received ${car.paid_amount}, expected ${quote.totalCost ?? 'unknown'}`);
      return;
    }
    await act(
      `leave:${car.plate}`,
      `Released paid car ${car.plate}`,
      () => request(`/cars/${encode(car.plate)}/leave`, { method: 'POST' }),
    );
    return;
  }

  if (car.status === 'departed' && !completed.has(car.plate)) {
    completed.add(car.plate);
    log(`Completed ${car.plate}; ${completed.size}/${maxCars} cars finished`);
  }
}

async function main() {
  const dashboard = await request('/dashboard');
  if (!dashboard.parking?.total || !dashboard.barriers?.length) {
    throw new Error('Level 1 is not loaded or synchronized; load it and call POST /api/v1/sync once');
  }
  if (!dashboard.barriers.some((gate) => gate.name === 'gateA')) {
    throw new Error('The loaded level is not Level 1: gateA was not found');
  }
  log(`Level 1 controller started with ${dashboard.parking.free}/${dashboard.parking.total} spaces free`);

  while (Date.now() < stopAt && completed.size < maxCars) {
    await discoverSessionCars();
    const cars = await getTrackedCars();
    const currentDashboard = await request('/dashboard');
    await manageEntry(cars, currentDashboard);
    for (const car of cars) await manageCar(car);
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }

  const finalDashboard = await request('/dashboard');
  log(`Stopped with ${completed.size} completed cars and ${finalDashboard.parking.free}/${finalDashboard.parking.total} spaces free`);
}

main().catch((error) => {
  console.error(`${new Date().toISOString()} Level 1 controller stopped: ${error.message}`);
  process.exitCode = 1;
});
