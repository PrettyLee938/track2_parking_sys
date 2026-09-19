/**
 * Entry point.  From the repo root:  npm run dev   (or npm start)
 */
import Fastify from "fastify";
import { registerRoutes } from "./app";
import { loadDotEnv, loadSettings, unknownSettingVars } from "./config";
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

const store = new Store(cfg.dataDir);
const controller = new Controller({ sim: new SimClient(cfg), cfg, store, log: app.log.child({ name: "controller" }) });
registerRoutes(app, { cfg, controller, store });

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
