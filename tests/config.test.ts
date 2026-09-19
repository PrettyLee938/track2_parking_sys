import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('allows unsigned webhooks by default only for the loopback simulator', () => {
    expect(loadConfig({ SIMULATOR_BASE_URL: 'http://127.0.0.1:9898' }).allowUnsignedSimulatorWebhooks).toBe(true);
    expect(loadConfig({ SIMULATOR_BASE_URL: 'https://simulator.example', ALLOW_UNSIGNED_SIMULATOR_WEBHOOKS: 'true' }).allowUnsignedSimulatorWebhooks).toBe(false);
    expect(loadConfig({ SIMULATOR_BASE_URL: 'http://localhost:9898', ALLOW_UNSIGNED_SIMULATOR_WEBHOOKS: 'false' }).allowUnsignedSimulatorWebhooks).toBe(false);
  });
});
