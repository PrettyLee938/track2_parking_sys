const path = require('node:path');

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadConfig(env = process.env, rootDir = path.resolve(__dirname, '..')) {
  return {
    appHost: env.APP_HOST || '127.0.0.1',
    appPort: parseInteger(env.APP_PORT, 8080),
    databasePath: path.resolve(rootDir, env.DATABASE_PATH || 'data/parking.db'),
    simulatorBaseUrl: (env.SIMULATOR_BASE_URL || 'http://127.0.0.1:9898').replace(/\/$/, ''),
    simulatorUsername: env.SIMULATOR_USERNAME || 'admin',
    simulatorPassword: env.SIMULATOR_PASSWORD || 'admin',
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'admin',
    operatorUsername: env.OPERATOR_USERNAME || 'operator',
    operatorPassword: env.OPERATOR_PASSWORD || 'operator',
    requireWebhookSignature: parseBoolean(env.REQUIRE_WEBHOOK_SIGNATURE, false),
    autoAssign: parseBoolean(env.AUTO_ASSIGN, true),
    autoCharge: parseBoolean(env.AUTO_CHARGE, true),
    entryGateName: env.ENTRY_GATE_NAME || 'gateA',
    gateCloseTimeoutMs: parseInteger(env.GATE_CLOSE_TIMEOUT_MS, 5000),
    exitGateName: env.EXIT_GATE_NAME || 'gateB',
    paymentConfirmTimeoutMs: parseInteger(env.PAYMENT_CONFIRM_TIMEOUT_MS, 90000),
    chargeDelayMs: parseInteger(env.CHARGE_DELAY_MS, 1500),
    releaseTimeoutMs: parseInteger(env.RELEASE_TIMEOUT_MS, 30000),
    rechargeAfterMs: parseInteger(env.RECHARGE_AFTER_MS, 4000),
    maxRechargeAttempts: parseInteger(env.MAX_RECHARGE_ATTEMPTS, 2),
    simulatedMinuteSeconds: parseInteger(env.SIMULATED_MINUTE_SECONDS, 10),
    gateSettleMs: parseInteger(env.GATE_SETTLE_MS, 2000),
    staleAssignmentMs: parseInteger(env.STALE_ASSIGNMENT_MS, 120000),
    reconcileIntervalMs: parseInteger(env.RECONCILE_INTERVAL_MS, 60000),
    dispatchIntervalMs: parseInteger(env.DISPATCH_INTERVAL_MS, 5000),
    closeBarriersOnStart: parseBoolean(env.CLOSE_BARRIERS_ON_START, true),
    resetStateOnStart: parseBoolean(env.RESET_STATE_ON_START, true),
    resetHistoryOnStart: parseBoolean(env.RESET_HISTORY_ON_START, false),
    rejectWhenFull: parseBoolean(env.REJECT_WHEN_FULL, true),
    maxEntryQueue: parseInteger(env.MAX_ENTRY_QUEUE, 5),
    bootstrapRetryMs: parseInteger(env.BOOTSTRAP_RETRY_MS, 5000),
  };
}

module.exports = { loadConfig, parseBoolean, parseInteger };
