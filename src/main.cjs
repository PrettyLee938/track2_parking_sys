const { loadEnvFile } = require('./env.cjs');

loadEnvFile();

const { loadConfig } = require('./config.cjs');
const { ParkingDatabase } = require('./database.cjs');
const { EventService } = require('./event-service.cjs');
const { SimulatorClient } = require('./simulator-client.cjs');
const { createParkingServer } = require('./server.cjs');

const config = loadConfig();
const database = new ParkingDatabase(config.databasePath);
const simulator = new SimulatorClient(config);
const events = new EventService(database, {
  requireWebhookSignature: config.requireWebhookSignature,
  simulator,
  autoAssign: config.autoAssign,
  autoCharge: config.autoCharge,
  entryGateName: config.entryGateName,
  gateCloseTimeoutMs: config.gateCloseTimeoutMs,
  exitGateName: config.exitGateName,
  paymentConfirmTimeoutMs: config.paymentConfirmTimeoutMs,
  chargeDelayMs: config.chargeDelayMs,
  releaseTimeoutMs: config.releaseTimeoutMs,
  rechargeAfterMs: config.rechargeAfterMs,
  maxRechargeAttempts: config.maxRechargeAttempts,
  simulatedMinuteSeconds: config.simulatedMinuteSeconds,
  gateSettleMs: config.gateSettleMs,
  staleAssignmentMs: config.staleAssignmentMs,
  reconcileIntervalMs: config.reconcileIntervalMs,
  rejectWhenFull: config.rejectWhenFull,
  maxEntryQueue: config.maxEntryQueue,
});
const server = createParkingServer({ config, database, simulator, events });

let shuttingDown = false;
let dispatchTimer = null;

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Discover the level, shut the entry barrier, then hand over to the dispatcher.
// Retries because the API is usually running before a level is loaded, and an
// unloaded level answers every list-* call with an empty array.
async function bootstrap() {
  // Clear the previous run's cars BEFORE waiting for a level. Doing it after the
  // level appears would also delete cars that arrived during the wait, and those
  // cars are already sitting on the entry spot with no further event coming, so
  // they could never be placed.
  if (config.resetStateOnStart) {
    const removed = database.resetCarState();
    if (removed) console.log(`Cleared ${removed} car records from the previous run`);
  }
  if (config.resetHistoryOnStart) {
    const cleared = database.resetHistory();
    console.log(`Cleared history: ${cleared.events} events and ${cleared.commands} commands`);
  }

  for (let attempt = 1; !shuttingDown; attempt += 1) {
    try {
      const snapshot = await simulator.syncAll();
      events.storeSync(snapshot);
      const spots = (snapshot.parkingSpots || []).length;
      if (!spots) {
        if (attempt === 1) console.log('Waiting for a level to be loaded in the simulator...');
        await wait(config.bootstrapRetryMs);
        continue;
      }

      console.log(`Synchronized ${spots} spots and ${(snapshot.barriers || []).length} barriers`);
      if (config.closeBarriersOnStart) {
        // Close only the entry and exit barriers. Other barriers carry the route
        // between the entrance and the parking spots: shutting them makes the
        // simulator fail pathing and refuse to spawn cars at all
        // ("Won't spawn car No path from A to P2").
        const entryResult = await events.closeEntryGateIfIdle();
        console.log(entryResult.closed
          ? `Entry barrier closing: ${entryResult.name}`
          : `Entry barrier already closed or unavailable: ${config.entryGateName}`);
        const exitResult = await events.closeExitGateIfIdle();
        console.log(exitResult.closed
          ? `Exit barrier closing: ${exitResult.name}`
          : `Exit barrier already closed or unavailable: ${config.exitGateName}`);
      }
      const route = await events.openRouteBarriers();
      if (route.opened.length) console.log(`Route barriers opened: ${route.opened.join(', ')}`);
      for (const entry of route.failed) {
        console.warn(`Could not open route barrier ${entry.name}: ${entry.error}`);
      }
      return true;
    } catch (error) {
      console.warn(`Startup attempt ${attempt} failed: ${error.message}`);
      await wait(config.bootstrapRetryMs);
    }
  }
  return false;
}

function runDispatch(reason) {
  return Promise.resolve(events.runDispatch())
    .catch((error) => console.error(`Dispatch (${reason}) failed: ${error.message}`));
}

server.listen(config.appPort, config.appHost, async () => {
  console.log(`Parking control API: http://${config.appHost}:${config.appPort}/api/v1`);
  console.log(`Simulator webhook: http://${config.appHost}:${config.appPort}/webhook`);
  console.log(`Database: ${config.databasePath}`);

  if (!await bootstrap()) return;
  await runDispatch('startup');

  // Webhooks already trigger a dispatch; this heartbeat covers the gaps, so the
  // park keeps moving even if events pause.
  if (config.dispatchIntervalMs > 0) {
    dispatchTimer = setInterval(() => runDispatch('interval'), config.dispatchIntervalMs);
  }
  console.log('Automatic entry, guidance and exit are running');
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  if (dispatchTimer) clearInterval(dispatchTimer);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, database, simulator, events };
