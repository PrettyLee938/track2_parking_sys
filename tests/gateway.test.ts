import { describe, expect, it } from 'vitest';
import { FixtureGateway } from '../src/simulator/fixture-gateway.js';

describe('simulator gateway boundary', () => {
  it('replays a snapshot and records accepted commands', async () => {
    const gateway = new FixtureGateway({ runId: 'run-7', levelId: 'lvl1' });
    expect((await gateway.send({ id: 'c-1', kind: 'gate.open', target: 'gates/entry/open', payload: {} })).accepted).toBe(false);
    await gateway.login();
    expect((await gateway.discover()).runId).toBe('run-7');
    expect((await gateway.send({ id: 'c-1', kind: 'gate.open', target: 'gates/entry/open', payload: {} })).accepted).toBe(true);
    expect(gateway.commands).toHaveLength(1);
  });
});
