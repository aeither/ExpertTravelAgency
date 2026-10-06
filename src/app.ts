import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { HttpClient, type Fetch } from './http.js';
import { Store, type Storage } from './store.js';
import { PostgresStore } from './postgres-store.js';
import { Travel } from './travel.js';
import { Masumi, inputSchema, startJobSchema } from './masumi.js';
import * as s from './schemas.js';
import { demoHtml } from './demo-ui.js';
import { withSearchExamples } from './openapi-examples.js';
import { Sokosumi } from './sokosumi.js';
import { journaledBooking } from './journal.js';
import { coworkerHtml } from './coworker-ui.js';
import { destinationKnowledge } from './knowledge.js';

export async function buildApp(config: Config, options: { fetch?: Fetch; poll?: boolean; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.token'] } : false, bodyLimit: 128000 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  const databaseUrl = config.DATABASE_URL_UNPOOLED || config.DATABASE_URL;
  const store: Storage = databaseUrl ? new PostgresStore(databaseUrl) : new Store(config.DATA_PATH);
  if (store instanceof PostgresStore) await store.initialize();
  const http = new HttpClient(config.UPSTREAM_TIMEOUT_MS, options.fetch);
  const travel = new Travel(config, http);
  const masumi = new Masumi(config, http, store, travel);
  const sokosumi = new Sokosumi(config, store, travel);
  const isPublic = (path: string) => ['/health', '/availability', '/input_schema', '/demo', '/demo-ui', '/coworker', '/v1/sokosumi/tick', '/start_job', '/status', '/v1/demo/simulate-payment'].includes(path) ||
    (config.PUBLIC_SEARCH && (path === '/' || path.startsWith('/docs') || path === '/openapi.json' || path === '/v1/capabilities' || path.endsWith('/search') || path.startsWith('/v1/flights/offers/') || path.startsWith('/v1/stays/hotels/')));
  app.addHook('onRoute', route => {
    if (isPublic(route.url)) route.schema = { ...route.schema, security: [] };
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/internal/masumi/tick') return;
    // Marketplace discovery and paid MIP-003 jobs must be reachable by buyers.
    // Supplier booking and administrative routes still require the API key.
    if (isPublic(path)) return;
    if (config.API_KEY) {
      const provided = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${config.API_KEY}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Supply the API bearer token.' } });
    }
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { info: { title: 'Origin travel API', version: '0.1.0', description: 'Travel search and supplier booking. AI tools can call these routes later.' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }] }, transform: jsonSchemaTransform });
  await app.register(swaggerUI, { routePrefix: '/docs', transformSpecification: withSearchExamples });
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    if (error.validation || error.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'The request does not match the API schema.', details: error.validation?.map((v: any) => ({ path: v.instancePath, message: v.message })) } });
    if (error.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } });
    if (error.statusCode === 413) return reply.code(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'The request exceeds 128 KB.' } });
    // Do not log supplier bodies, tokens, or traveler fields.
    request.log.error({ code: 'INTERNAL_ERROR' }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The request failed.' } });
  });
  const idParams = z.object({ id: s.resourceId });
  const tag = (name: string, summary: string) => ({ tags: [name], summary });
  app.get('/', { schema: { hide: true } }, async (_request, reply) => reply.redirect('/docs'));
  app.get('/internal/masumi/tick', { schema: { hide: true } }, async (request, reply) => {
    if (!config.CRON_SECRET || request.headers.authorization !== `Bearer ${config.CRON_SECRET}`) return reply.code(401).send({ error: 'Unauthorized' });
    await masumi.tick(1);
    return { ok: true };
  });
  app.get('/health', { schema: { ...tag('System', 'Check the API process'), security: [] } }, async () => ({ status: 'ok', mode: config.TRAVEL_MODE }));
  app.get('/coworker', { schema: { hide: true } }, async (_request, reply) => reply.type('text/html').header('cache-control', 'no-store').send(coworkerHtml));
  // Public wake-up only: no caller-selected task, input, credentials, or result is returned.
  app.post('/v1/sokosumi/tick', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { ...tag('Sokosumi', 'Check assigned Coworker tasks (execution rehearsal)'), body: z.object({}).strict() } }, () => sokosumi.tick());
  // Called by the Travel Expert orchestrator. Needs the API key like the booking routes.
  app.post('/v1/knowledge', { schema: { ...tag('Knowledge', 'General destination knowledge for other agents'), body: z.object({ destination: z.string().min(2).max(80), question: z.string().min(3).max(300).optional() }).strict() } }, r => destinationKnowledge(config, r.body));
  app.get('/v1/capabilities', { schema: tag('System', 'Check configured provider access') }, async () => travel.capabilities());
  app.get('/openapi.json', { schema: { hide: true } }, async () => withSearchExamples(app.swagger()));
  app.post('/v1/flights/search', { schema: { ...tag('Flights', 'Search flight offers'), body: s.flightSearch } }, r => travel.flights(r.body));
  app.get('/v1/flights/offers/:id', { schema: { ...tag('Flights', 'Refresh a flight offer'), params: idParams } }, r => travel.offer(r.params.id));
  app.post('/v1/stays/search', { schema: { ...tag('Stays', 'Search hotels with live room rates'), body: s.staySearch } }, r => travel.stays(r.body));
  app.post('/v1/trips/search', { schema: { ...tag('Trips', 'Search travel categories in parallel'), body: s.tripSearch } }, r => travel.trip(r.body));
  const book = (kind: string, key: string, input: unknown, action: (id: string, submitted: () => Promise<void>) => Promise<unknown>) => journaledBooking(store, config, kind, key, input, action);
  app.post('/v1/flights/bookings', { schema: { ...tag('Flights', 'Book a refreshed flight offer'), headers: s.idempotencyHeaders, body: s.flightBooking } }, r => book('flight', r.headers['idempotency-key'], r.body, (id, submitted) => travel.bookFlight(r.body, id, submitted)));
  app.get('/v1/stays/hotels/:id', { schema: { ...tag('Stays', 'Get hotel photos, facilities, and review highlights'), params: idParams } }, r => travel.hotel(r.params.id));
  app.post('/v1/stays/bookings', { schema: { ...tag('Stays', 'Book a hotel offer within a budget'), headers: s.idempotencyHeaders, body: s.stayBooking } }, r => book('stay', r.headers['idempotency-key'], r.body, (id, submitted) => travel.bookStay(r.body, id, submitted)));
  app.get('/v1/bookings/stay/:id', { schema: { ...tag('Bookings', 'Get hotel booking status'), params: idParams } }, r => travel.stayBooking(r.params.id));
  app.get('/v1/bookings/flight/:id', { schema: { ...tag('Bookings', 'Get flight booking status'), params: idParams } }, r => travel.booking(r.params.id));
  app.get('/v1/operations/:id', { schema: { ...tag('Bookings', 'Inspect a saved booking operation'), params: z.object({ id: z.uuid() }) } }, r => store.get(r.params.id));
  app.get('/v1/masumi/health', { schema: tag('Masumi', 'Check the configured payment node') }, () => masumi.health());
  // A simulated rail must never advertise itself to real buyers as payable.
  app.get('/availability', { schema: tag('Masumi', 'Check paid search availability') }, async () => ({ status: masumi.configured && !masumi.simulated && !travel.isDemo ? 'available' : 'unavailable', type: 'masumi-agent', ...(masumi.simulated ? { message: 'Rehearsal mode: settlement is simulated and not payable.' } : {}) }));
  app.get('/demo', { schema: tag('Masumi', 'Sample input and output for marketplace previews') }, async () => ({
    input: { trip_request_json: JSON.stringify({ flights: { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: '2026-12-01' }], passengers: [{ type: 'adult' }] }, stays: { check_in_date: '2026-12-01', check_out_date: '2026-12-04', rooms: [{ adults: 1 }], location: { city: 'Bangkok', country_code: 'TH' } } }) },
    output: { result: JSON.stringify({ complete: true, summary: { flights: { cheapest: { airline: 'Example Air', total: { amount: '95.00', currency: 'EUR' }, stops: 0 } }, hotels: { cheapest: { name: 'Example Hotel', total: { amount: '210.00', currency: 'USD' } } } }, note: 'Illustrative sample, not a live quote.' }) },
  }));
  app.get('/demo-ui', { schema: { hide: true } }, async (_request, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(demoHtml));
  app.post('/v1/demo/simulate-payment', { schema: { ...tag('Masumi', 'Rehearsal only: fund the simulated escrow for a job'), body: z.object({ job_id: z.uuid() }).strict() } }, r => masumi.simulatePayment(r.body.job_id));
  app.get('/input_schema', { schema: tag('Masumi', 'Get the MIP-003 input schema') }, async () => inputSchema);
  app.post('/start_job', { schema: { ...tag('Masumi', 'Create a paid travel search job on Preprod'), body: startJobSchema } }, r => masumi.start(r.body));
  app.get('/status', { schema: { ...tag('Masumi', 'Get paid job status and result'), querystring: z.object({ job_id: z.uuid() }) } }, r => masumi.status(r.query.job_id, !!databaseUrl));
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  if (options.poll !== false && masumi.configured) {
    timer = setInterval(() => { if (!ticking) ticking = masumi.tick().finally(() => { ticking = undefined; }); }, 5000);
    timer.unref();
  }
  // A long-running host (laptop or Railway) can poll Sokosumi itself; serverless hosts are driven by /v1/sokosumi/tick instead.
  let coworkerTimer: ReturnType<typeof setInterval> | undefined;
  let coworkerTicking: Promise<void> | undefined;
  if (options.poll !== false && config.SOKOSUMI_POLL && sokosumi.configured) {
    coworkerTimer = setInterval(() => { if (!coworkerTicking) coworkerTicking = sokosumi.tick().then(r => { if (r.status !== 'idle') app.log.info({ sokosumi: r.status }, 'coworker tick'); }).catch(e => app.log.error({ err: e?.code ?? 'TICK_FAILED' }, 'coworker tick failed')).finally(() => { coworkerTicking = undefined; }); }, 10000);
    coworkerTimer.unref();
  }
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); if (coworkerTimer) clearInterval(coworkerTimer); await ticking; await coworkerTicking; await store.close(); });
  await app.ready();
  return { app, store, travel, masumi };
}
