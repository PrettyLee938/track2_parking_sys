const test = require('node:test');
const assert = require('node:assert/strict');
const { SimulatorClient, SimulatorError } = require('../src/simulator-client.cjs');

const config = {
  simulatorBaseUrl: 'http://simulator.invalid',
  simulatorUsername: 'admin',
  simulatorPassword: 'admin',
};

function stubFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      const handler = handlers.shift();
      if (!handler) throw new Error('unexpected call');
      if (handler instanceof Error) throw handler;
      return handler;
    },
  };
}

function ok(body, status = 200) {
  return { ok: true, status, text: async () => JSON.stringify(body) };
}

test('retries a drive command once when the connection is reset', async () => {
  const stub = stubFetch([
    ok({ token: 'jwt' }),
    new TypeError('fetch failed'), // Keep-alive socket reset.
    ok(null, 201),
  ]);
  const client = new SimulatorClient(config, stub.fetch);
  const result = await client.moveCar('FEL 420', 'S1');

  assert.equal(result.status, 201);
  assert.equal(stub.calls.length, 3, 'login, failed attempt, successful retry');
  assert.equal(stub.calls[1].url, stub.calls[2].url);
});

test('never retries a charge, because a repeat would double-charge', async () => {
  const stub = stubFetch([ok({ token: 'jwt' }), new TypeError('fetch failed')]);
  const client = new SimulatorClient(config, stub.fetch);

  await assert.rejects(() => client.chargeCar('FEL 420', 2, 0), (error) => {
    assert.ok(error instanceof SimulatorError);
    assert.match(error.message, /fetch failed/); // Underlying cause is kept.
    return true;
  });
  assert.equal(stub.calls.length, 2, 'login and one attempt only');
});

test('gives up after a single retry rather than looping', async () => {
  const stub = stubFetch([
    ok({ token: 'jwt' }),
    new TypeError('fetch failed'),
    new TypeError('fetch failed'),
  ]);
  const client = new SimulatorClient(config, stub.fetch);
  await assert.rejects(() => client.moveCar('FEL 420', 'S1'), /Simulator request failed/);
  assert.equal(stub.calls.length, 3);
});
