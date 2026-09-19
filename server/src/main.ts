/**
 * Entry point.  From the repo root:  npm run dev   (or npm start)
 */
import Fastify from "fastify";
import { registerRoutes } from "./app";
import { AuthService } from "./auth";
import { loadDotEnv, loadSettings, outOfRangeTunables, unknownSettingVars } from "./config";
import { Controller } from "./controller";
import { SimClient } from "./simClient";
import { Store } from "./store";

loadDotEnv();
const cfg = loadSettings();

const app = Fastify({
  logger: {
    level: cfg.logLevel,
    transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,reqId" } },
  },
});

const unknown = unknownSettingVars();
if (unknown.length) app.log.warn(`ignoring unknown settings (typo or old name?): ${unknown.join(", ")} - see .env.example`);

// min/max bound what an admin may TYPE, not the value itself. A bound edited to look like
// a value (max: 5 when the default is 50) leaves the setting above its own ceiling, and
// then every dashboard settings save is rejected over a field nobody touched.
for (const problem of outOfRangeTunables(cfg)) {
  app.log.warn(`${problem} - the dashboard cannot save settings until this is fixed (TUNABLES in server/src/config.ts)`);
}

if (cfg.adminPassword && cfg.adminPassword.length < 8) {
  app.log.warn("GPA_ADMIN_PASSWORD is shorter than 8 characters - fine for a local demo, not for anything shared");
}

const store = new Store(cfg.dataDir);
const auth = new AuthService(store, cfg);
const created = await auth.bootstrap();
if (created) {
  app.log.warn(created.generatedPassword
    ? `created admin account '${created.username}' with password: ${created.generatedPassword}  (shown once - sign in and change it, or set GPA_ADMIN_PASSWORD before first start)`
    : `created admin account '${created.username}' with the password from GPA_ADMIN_PASSWORD`);
}

const controller = new Controller({ sim: new SimClient(cfg), cfg, store, log: app.log.child({ name: "controller" }) });
registerRoutes(app, { cfg, controller, store, auth });

if (cfg.controllerEnabled) {
  controller.start();
  app.log.info("controller started");
} else {
  app.log.warn("controller disabled: passive mode, events are logged but no commands are sent");
}

const shutdown = async () => {
  controller.stop();
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: cfg.appHost, port: cfg.appPort });
