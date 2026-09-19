export interface Config {
  host: string;
  port: number;
  databasePath: string;
  simulatorBaseUrl: string;
  simulatorName: string | undefined;
  simulatorPassword: string | undefined;
  entryGateName: string;
  adminUsername: string | undefined;
  adminInitialPassword: string | undefined;
  allowUnsignedSimulatorWebhooks: boolean;
  sessionIdleMs: number;
}

const numberEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isLocalSimulator = (baseUrl: string) => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const simulatorBaseUrl = env.SIMULATOR_BASE_URL || 'http://127.0.0.1:9898';
  const unsignedSetting = env.ALLOW_UNSIGNED_SIMULATOR_WEBHOOKS?.trim().toLowerCase();
  return {
    host: env.HOST || '127.0.0.1',
    port: numberEnv(env.PORT, 3000),
    databasePath: env.DATABASE_PATH || './data/parking.db',
    simulatorBaseUrl,
    simulatorName: env.SIMULATOR_NAME || undefined,
    simulatorPassword: env.SIMULATOR_PASSWORD || undefined,
    entryGateName: env.ENTRY_GATE_NAME || 'gateA',
    adminUsername: env.ADMIN_USERNAME || undefined,
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || undefined,
    allowUnsignedSimulatorWebhooks: isLocalSimulator(simulatorBaseUrl) && (unsignedSetting === undefined || unsignedSetting === '' || unsignedSetting === 'true'),
    sessionIdleMs: numberEnv(env.SESSION_IDLE_MS, 30 * 60 * 1000)
  };
}
