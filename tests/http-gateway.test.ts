import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { HttpSimulatorGateway } from '../src/simulator/http-gateway.js';

const config: Config = {
  host: '127.0.0.1', port: 3000, databasePath: ':memory:', simulatorBaseUrl: 'http://simulator',
  simulatorName: 'moha', simulatorPassword: 'moha', adminUsername: 'admin', adminInitialPassword: 'admin', allowUnsignedSimulatorWebhooks: false, sessionIdleMs: 1_000
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HTTP simulator gateway', () => {
  it('uses documented list routes and normalizes the simulator inventory', async () => {
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/api/v1/auth/login') return response({ token: 'token' });
      if (path === '/api/v1/list-parking-spots') return response([
        { name: 'S1', purpose: 'Park', parkingForCarType: 'Electric', zoneParent: 'ZONE1', detectedCars: ['ABC'], broken: false, isUnderMaintenance: false },
        { name: 'ENTRY1', purpose: 'EntrySpot', parkingForCarType: 'Any', detectedCars: [], broken: false, isUnderMaintenance: false }
      ]);
      if (path === '/api/v1/list-barriers') return response([{ name: 'gate0', state: 'Open', zoneParent: '' }]);
      if (path === '/api/v1/list-lights') return response([{ name: 'light0', isOn: true, zoneParent: 'ZONE1' }]);
      if (path === '/api/v1/list-exhaust-fans') return response([]);
      if (path === '/api/v1/list-alarms') return response([]);
      if (path === '/api/v1/list-zones') return response([{ name: 'ZONE1', gasCarbonMonoxideLevel: 0, risk: 'Safe' }]);
      if (path === '/api/v1/status') return response({ isActive: false, cars: 24 });
      if (path === '/api/v1/barrier-gates/gate0/open') return new Response(null, { status: 201 });
      return response({}, 404);
    };

    const snapshot = await new HttpSimulatorGateway(config, fetcher).discover();

    expect(snapshot.spots).toHaveLength(1);
    expect(snapshot.spots[0]).toMatchObject({ id: 'S1', type: 'electric', occupied: true, reachable: true, zoneSafe: true });
    expect(snapshot.barriers?.[0]).toMatchObject({ id: 'gate0', kind: 'barrier-gate' });
    expect(snapshot.runId).toMatch(/^local-/);
    expect(snapshot.runId).toBe(await new HttpSimulatorGateway(config, fetcher).discover().then((next) => next.runId));
    expect((await new HttpSimulatorGateway(config, fetcher).send({ id: 'command-1', kind: 'gate.open', target: '/api/v1/barrier-gates/gate0/open', payload: {} })).accepted).toBe(true);
    expect(paths).toEqual(expect.arrayContaining([
      '/api/v1/auth/login', '/api/v1/list-parking-spots', '/api/v1/list-barriers',
      '/api/v1/list-lights', '/api/v1/list-exhaust-fans', '/api/v1/list-alarms', '/api/v1/list-zones', '/api/v1/status'
    ]));
  });

  it('waits for a loaded level instead of accepting an empty inventory', async () => {
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/auth/login') return response({ token: 'token' });
      if (path === '/api/v1/list-parking-spots') return response([]);
      return response([], 200);
    };
    await expect(new HttpSimulatorGateway(config, fetcher).discover()).rejects.toThrow('simulator-level-not-loaded');
  });
});
