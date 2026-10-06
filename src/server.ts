import { getConfig } from './config.js';
import { buildApp } from './app.js';

const config = getConfig();
const { app } = await buildApp(config, { logger: true });
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`Origin travel API: http://${config.HOST}:${config.PORT}/docs (${config.TRAVEL_MODE})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await app.close(); process.exit(0); });
