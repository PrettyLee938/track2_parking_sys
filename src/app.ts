import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService } from './auth/service.js';
import { loadConfig, type Config } from './config.js';
import { Database } from './db/database.js';
import { AuditService } from './services/audit.js';
import { CommandService } from './services/command-service.js';
import { EquipmentService } from './services/equipment-service.js';
import { EventService } from './services/event-service.js';
import { EventController } from './services/event-controller.js';
import { ParkingService } from './services/parking-service.js';
import { PaymentService } from './services/payment-service.js';
import { RecoveryService } from './services/recovery-service.js';
import { FixtureGateway } from './simulator/fixture-gateway.js';
import type { SimulatorGateway } from './simulator/contracts.js';
import { HttpSimulatorGateway } from './simulator/http-gateway.js';
import { registerAuthRoutes } from './api/auth-routes.js';
import { registerEquipmentRoutes } from './api/equipment-routes.js';
import { registerParkingRoutes } from './api/parking-routes.js';
import { registerRecoveryRoutes } from './api/recovery-routes.js';
import { registerSystemRoutes } from './api/system-routes.js';
import { registerWebhookRoutes } from './api/webhook-routes.js';

export interface AppContext {
  db: Database;
  gateway: SimulatorGateway;
  auth: AuthService;
  audit: AuditService;
  events: EventService;
  commands: CommandService;
  parking: ParkingService;
  payments: PaymentService;
  equipment: EquipmentService;
  recovery: RecoveryService;
}

export interface AppOptions { config?: Config; db?: Database; gateway?: SimulatorGateway; }

export function buildApp(options: AppOptions = {}): { app: FastifyInstance; context: AppContext } {
  const config = options.config || loadConfig();
  const ownsDb = !options.db;
  const db = options.db || new Database(config.databasePath);
  const gateway = options.gateway || new HttpSimulatorGateway(config);
  const audit = new AuditService(db);
  const auth = new AuthService(db, config.sessionIdleMs);
  const events = new EventService(db, audit, () => Date.now(), gateway.webhookBoundary());
  const commands = new CommandService(db, gateway, audit);
  const parking = new ParkingService(db, commands, audit);
  const payments = new PaymentService(db, commands, auth, audit);
  const equipment = new EquipmentService(db, commands, audit);
  const eventController = new EventController(equipment, parking, payments, commands);
  const recovery = new RecoveryService(db, gateway, parking, audit);
  const context = { db, gateway, auth, audit, events, commands, parking, payments, equipment, recovery };
  const app = Fastify({ logger: false });

  auth.invalidateAll();

  registerAuthRoutes(app, auth, audit);
  registerSystemRoutes(app, auth, gateway, events, commands, audit, recovery);
  registerWebhookRoutes(app, events, eventController);
  registerParkingRoutes(app, auth, parking, payments);
  registerEquipmentRoutes(app, auth, equipment);
  registerRecoveryRoutes(app, auth, recovery, commands);
  app.addHook('onReady', async () => {
    await auth.seedAdmin(config.adminUsername, config.adminInitialPassword);
    recovery.startAutomaticResume();
    try { await gateway.login(); await parking.refreshSnapshot(await gateway.discover()); }
    catch (error) { audit.record('simulator-connect-failed', 'simulator', undefined, { error: error instanceof Error ? error.message : String(error) }); }
  });
  app.addHook('onClose', async () => { recovery.stopAutomaticResume(); auth.invalidateAll(); if (ownsDb) db.close(); });
  return { app, context };
}
