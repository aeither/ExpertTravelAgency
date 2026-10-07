import { getConfig } from './config.js';
import { buildApp } from './app.js';

const config = getConfig();
const { app } = await buildApp(config, { logger: true });
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`Origin travel API: http://${config.HOST}:${config.PORT}/docs (${config.TRAVEL_MODE})`);
// Drain once. A second signal or a stuck poll must not leave the process hanging, so exit anyway after 25 seconds.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(1), 25000).unref();
  try { await app.close(); process.exit(0); } catch (error) { console.error('shutdown failed:', String((error as Error)?.message ?? error).slice(0, 200)); process.exit(1); }
});
