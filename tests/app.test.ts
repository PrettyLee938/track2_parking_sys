import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Database } from '../src/db/database.js';
import { FixtureGateway } from '../src/simulator/fixture-gateway.js';
import { signatureDigest } from '../src/simulator/signature.js';

describe('backend HTTP boundary', () => {
  it('serves health, authentication, webhook ingestion, and arrival allocation', async () => {
    const payload = { EventId: 'e-http', SequenceId: '1', Type: 'test_webhook' };
    const gateway = new FixtureGateway({ runId: 'run-http', spots: [{ id: 'N-1', type: 'any', accessible: false, occupied: false, reserved: false, broken: false, underMaintenance: false, reachable: true, zoneSafe: true, rank: 1 }] });
    const config = { host: '127.0.0.1', port: 3000, databasePath: ':memory:', simulatorBaseUrl: 'http://fixture', simulatorName: undefined, simulatorPassword: undefined, adminUsername: 'admin', adminInitialPassword: 'secret', sessionIdleMs: 30_000 };
    const { app } = buildApp({ db: new Database(':memory:'), gateway, config });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'secret' } });
    expect(login.statusCode).toBe(200);
    const token = login.json().token;
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { authorization: `Bearer ${token}` }, payload: { password: 'new-secret' } })).statusCode).toBe(200);
    const webhook = await app.inject({ method: 'POST', url: '/webhooks/simulator', payload: { ...payload, Signature: signatureDigest(payload) } });
    expect(webhook.statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/webhooks/simulator', payload: { ...payload, Signature: signatureDigest(payload) } })).statusCode).toBe(200);
    const arrival = await app.inject({ method: 'POST', url: '/api/v1/parking/arrivals', headers: { authorization: `Bearer ${token}` }, payload: { plate: 'ABC', type: 'normal', accessible: false, needsCharging: false } });
    expect(arrival.statusCode).toBe(201);
    await app.close();
  });
});
