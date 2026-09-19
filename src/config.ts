export interface Config {
  host: string;
  port: number;
  databasePath: string;
  simulatorBaseUrl: string;
  simulatorName: string | undefined;
  simulatorPassword: string | undefined;
  adminUsername: string | undefined;
  adminInitialPassword: string | undefined;
  sessionIdleMs: number;
}

const numberEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || '127.0.0.1',
    port: numberEnv(env.PORT, 3000),
    databasePath: env.DATABASE_PATH || './data/parking.db',
    simulatorBaseUrl: env.SIMULATOR_BASE_URL || 'http://127.0.0.1:9898',
    simulatorName: env.SIMULATOR_NAME || undefined,
    simulatorPassword: env.SIMULATOR_PASSWORD || undefined,
    adminUsername: env.ADMIN_USERNAME || undefined,
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || undefined,
    sessionIdleMs: numberEnv(env.SESSION_IDLE_MS, 30 * 60 * 1000)
  };
}
