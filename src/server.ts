import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = buildApp({ config });
await app.listen({ host: config.host, port: config.port });
console.log(`Parking backend listening on http://${config.host}:${config.port}`);
