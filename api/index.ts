import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';

let application: ReturnType<typeof buildApp> | undefined;
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  application ??= (async () => {
    const config = getConfig();
    if (!config.DATABASE_URL_UNPOOLED) throw new Error('Configure the Neon direct connection before deploying.');
    return buildApp(config, { poll: false, logger: true });
  })().catch(error => { application = undefined; throw error; });
  const { app } = await application;
  app.server.emit('request', request, response);
}
