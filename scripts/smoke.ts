// Calls every route on a running deployment and prints a pass/fail table.
//   npm run smoke                                   # hosted API, public routes
//   npm run smoke -- --base http://127.0.0.1:3026   # local server
//   npm run smoke -- --book                         # also place and replay a Duffel TEST flight booking
// Protected routes use API_KEY from the environment or .env.local; they are skipped without it.
import dotenv from 'dotenv';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const base = arg('base', process.env.BASE_URL ?? 'https://origin-travel-agent.vercel.app').replace(/\/$/, '');
const apiKey = process.env.API_KEY ?? '';
const book = process.argv.includes('--book');
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

type Result = { name: string; status: 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED'; ms: number; note: string };
const results: Result[] = [];
async function call(method: string, path: string, opts: { body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.auth && apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(90000), redirect: 'manual' });
  const text = await response.text();
  let json: any; try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: response.status, json, text, headers: response.headers };
}
async function check(name: string, fn: () => Promise<string | void>, kind: 'normal' | 'protected' | 'booking' = 'normal') {
  const start = Date.now();
  if (kind === 'protected' && !apiKey) return void results.push({ name, status: 'SKIP', ms: 0, note: 'needs API_KEY' });
  if (kind === 'booking' && (!apiKey || !book)) return void results.push({ name, status: 'SKIP', ms: 0, note: apiKey ? 'pass --book to run' : 'needs API_KEY' });
  try { const note = (await fn()) ?? ''; results.push({ name, status: 'PASS', ms: Date.now() - start, note }); }
  catch (error: any) { results.push({ name, status: error.blocked ? 'BLOCKED' : 'FAIL', ms: Date.now() - start, note: String(error.message).slice(0, 150) }); }
}
const expect = (cond: unknown, message: string) => { if (!cond) throw new Error(message); };
const blocked = (message: string) => Object.assign(new Error(message), { blocked: true });

const flights = { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: day(30) }], passengers: [{ type: 'adult' }], cabin_class: 'economy', max_connections: 1 };
const stays = { check_in_date: day(30), check_out_date: day(33), rooms: [{ adults: 1 }], location: { city: 'Bangkok', country_code: 'TH' }, limit: 5 };
let caps: any, offer: any, operationId = '';

await check('GET /health', async () => { const r = await call('GET', '/health'); expect(r.status === 200 && r.json.status === 'ok', `HTTP ${r.status}`); return `mode ${r.json.mode}`; });
await check('GET / redirects to docs', async () => { const r = await call('GET', '/'); expect(r.status === 302 && r.headers.get('location') === '/docs', `HTTP ${r.status}`); });
await check('GET /docs', async () => { const r = await call('GET', '/docs/'); expect(r.status === 200 && r.text.includes('swagger'), `HTTP ${r.status}`); });
await check('GET /openapi.json', async () => { const r = await call('GET', '/openapi.json'); expect(r.status === 200 && r.json.paths['/v1/stays/search'], `HTTP ${r.status}`); return `${Object.keys(r.json.paths).length} paths`; });
await check('GET /v1/capabilities', async () => { const r = await call('GET', '/v1/capabilities'); expect(r.status === 200, `HTTP ${r.status}`); caps = r.json; expect(caps.flights.credentials_present, 'Duffel credentials missing'); expect(caps.stays.credentials_present, 'LiteAPI credentials missing'); return `settlement ${caps.masumi.mode}`; });
await check('POST /v1/flights/search', async () => { const r = await call('POST', '/v1/flights/search', { body: flights }); expect(r.status === 200, `HTTP ${r.status} ${r.json?.error?.code}`); offer = r.json.data.offers?.[0]; expect(offer, 'no offers'); return `${r.json.data.offers.length} offers (${r.json.environment})`; });
await check('GET /v1/flights/offers/:id', async () => { expect(offer, 'no offer from search'); const r = await call('GET', `/v1/flights/offers/${offer.id}`); expect(r.status === 200 && r.json.data.id === offer.id, `HTTP ${r.status}`); return `${r.json.data.total_currency} ${r.json.data.total_amount}`; });
await check('POST /v1/stays/search', async () => { const r = await call('POST', '/v1/stays/search', { body: stays }); expect(r.status === 200, `HTTP ${r.status} ${r.json?.error?.code}`); const h = r.json.data.hotels; expect(h.length && h[0].rooms.length, 'no hotels with rooms'); return `${h.length} hotels (${r.json.environment})`; });
await check('GET /v1/stays/hotels/:id (photos, facilities, reviews)', async () => {
  const search = await call('POST', '/v1/stays/search', { body: stays });
  const id = search.json.data.hotels[0].id;
  const r = await call('GET', `/v1/stays/hotels/${id}`);
  expect(r.status === 200, `HTTP ${r.status} ${r.json?.error?.code}`);
  expect(r.json.data.photos.length && r.json.data.facilities.length, 'no photos or facilities');
  return `${r.json.data.name}: ${r.json.data.photos.length} photos, ${r.json.data.facilities.length} facilities`;
});
await check('POST /v1/stays/search rejects bad dates', async () => { const r = await call('POST', '/v1/stays/search', { body: { ...stays, check_out_date: day(10) } }); expect(r.status === 400, `HTTP ${r.status}`); });
await check('POST /v1/trips/search', async () => { const r = await call('POST', '/v1/trips/search', { body: { flights, stays } }); expect(r.status === 200 && r.json.complete, `HTTP ${r.status} complete=${r.json?.complete}`); expect(r.json.summary.flights.cheapest && r.json.summary.hotels.top_rated.length, 'summary incomplete'); return `cheapest ${r.json.summary.flights.cheapest.total.currency} ${r.json.summary.flights.cheapest.total.amount}`; });
await check('GET /demo-ui', async () => { const r = await call('GET', '/demo-ui'); expect(r.status === 200 && r.text.includes('Origin Travel Agent'), `HTTP ${r.status}`); });
await check('GET /demo (MIP-003)', async () => { const r = await call('GET', '/demo'); expect(r.status === 200 && r.json.input && r.json.output, `HTTP ${r.status}`); });
await check('GET /input_schema (MIP-003)', async () => { const r = await call('GET', '/input_schema'); expect(r.status === 200 && r.json.input_data?.[0]?.id === 'trip_request_json', `HTTP ${r.status}`); });
await check('GET /availability (MIP-003)', async () => { const r = await call('GET', '/availability'); expect(r.status === 200 && r.json.type === 'masumi-agent', `HTTP ${r.status}`); if (r.json.status !== 'available') throw blocked(`status ${r.json.status}${r.json.message ? ': ' + r.json.message : ''}`); return 'available'; });

// Paid flow. Rehearsal mode runs fully; live mode needs a buyer wallet, so it stops after the terms.
await check('POST /start_job → /status → verify proof', async () => {
  expect(caps, 'capabilities unavailable');
  if (caps.masumi.mode === 'unconfigured') throw blocked('payment service not configured (registration pending)');
  const nonce = randomBytes(10).toString('hex');
  const input = { trip_request_json: JSON.stringify({ flights, stays }) };
  const started = await call('POST', '/start_job', { body: { identifier_from_purchaser: nonce, input_data: input } });
  expect(started.status === 200, `start_job HTTP ${started.status} ${started.json?.error?.code}`);
  const job = started.json;
  expect(job.input_hash === sha256(`${nonce};${JSON.stringify(input)}`), 'input hash mismatch');
  const first = await call('GET', `/status?job_id=${job.id}`);
  expect(first.json.status === 'awaiting_payment', `expected awaiting_payment, got ${first.json.status}`);
  if (job.settlement !== 'simulated') throw blocked('terms OK; paying needs a funded Masumi buyer wallet (run npm run demo:buy)');
  const paid = await call('POST', '/v1/demo/simulate-payment', { body: { job_id: job.id } });
  expect(paid.status === 200, `simulate-payment HTTP ${paid.status}`);
  let status: any;
  for (let i = 0; i < 40; i++) { status = (await call('GET', `/status?job_id=${job.id}`)).json; if (['completed', 'failed'].includes(status.status)) break; await new Promise(r => setTimeout(r, 1500)); }
  expect(status.status === 'completed', `job ended ${status.status} (${status.error ?? status.phase})`);
  expect(sha256(`${nonce};${status.result}`) === status.result_hash, 'result hash mismatch');
  return `completed, ${job.settlement} settlement, hashes verified`;
});
await check('GET /status unknown job → 404', async () => { const r = await call('GET', `/status?job_id=${randomUUID()}`); expect(r.status === 404, `HTTP ${r.status}`); });

// Access control.
await check('Protected route rejects missing token', async () => { const r = await call('GET', '/v1/masumi/health'); expect(r.status === 401, `HTTP ${r.status}`); });
await check('POST /v1/flights/bookings rejects missing token', async () => { const r = await call('POST', '/v1/flights/bookings', { body: {}, headers: { 'idempotency-key': 'smoke-no-auth-1' } }); expect(r.status === 401, `HTTP ${r.status}`); });
await check('GET /v1/masumi/health (token)', async () => { const r = await call('GET', '/v1/masumi/health', { auth: true }); expect(r.status === 200, `HTTP ${r.status} ${r.json?.error?.code}`); if (r.json.configured === false) throw blocked('payment service not configured'); return `network ${r.json.network}${r.json.settlement ? ', ' + r.json.settlement : ''}`; }, 'protected');
await check('Flight booking validates input (token)', async () => { const r = await call('POST', '/v1/flights/bookings', { auth: true, body: { offer_id: 'off_x', passengers: [], confirm: false }, headers: { 'idempotency-key': 'smoke-invalid-1' } }); expect(r.status === 400, `HTTP ${r.status}`); }, 'protected');
await check('POST /v1/flights/bookings + replay (Duffel TEST)', async () => {
  const search = await call('POST', '/v1/flights/search', { body: flights });
  const chosen = search.json.data.offers[0];
  const fresh = (await call('GET', `/v1/flights/offers/${chosen.id}`)).json.data;
  expect(fresh.live_mode === false, 'refusing to book a live offer');
  const body = { offer_id: chosen.id, passengers: fresh.passengers.map((p: any) => ({ id: p.id, given_name: 'Smoke', family_name: 'Test', born_on: '1990-01-01', gender: 'm', title: 'mr', email: 'smoke@example.com', phone_number: '+6591234567' })), max_total: { amount: fresh.total_amount, currency: fresh.total_currency }, confirm: true };
  const key = `smoke-${randomUUID()}`;
  const first = await call('POST', '/v1/flights/bookings', { auth: true, body, headers: { 'idempotency-key': key } });
  expect(first.status === 200 && first.json.data.live_mode === false, `HTTP ${first.status} ${first.json?.error?.code}`);
  operationId = first.json.operation_id;
  const replay = await call('POST', '/v1/flights/bookings', { auth: true, body, headers: { 'idempotency-key': key } });
  expect(replay.json.replayed === true && replay.json.data.id === first.json.data.id, 'replay did not return the same booking');
  const status = await call('GET', `/v1/bookings/flight/${first.json.data.id}`, { auth: true });
  expect(status.status === 200, `status HTTP ${status.status}`);
  return `order ${first.json.data.id}`;
}, 'booking');
await check('POST /v1/stays/bookings + replay (LiteAPI sandbox)', async () => {
  const search = await call('POST', '/v1/stays/search', { body: { ...stays, currency: 'EUR' } });
  const room = search.json.data.hotels.flatMap((h: any) => h.rooms).find((r: any) => r.refundable) ?? search.json.data.hotels[0].rooms[0];
  expect(room?.offer_id && room.total, 'no bookable room in search');
  expect(search.json.environment === 'sandbox', 'refusing to book outside the sandbox');
  const body = { offer_id: room.offer_id, guests: [{ given_name: 'Smoke', family_name: 'Test', email: 'smoke@example.com' }], max_total: { amount: String(Math.ceil(Number(room.total.amount) * 1.05)), currency: room.total.currency }, confirm: true };
  const key = `smoke-stay-${randomUUID()}`;
  const first = await call('POST', '/v1/stays/bookings', { auth: true, body, headers: { 'idempotency-key': key } });
  expect(first.status === 200 && first.json.data.status === 'CONFIRMED', `HTTP ${first.status} ${first.json?.error?.code}`);
  const replay = await call('POST', '/v1/stays/bookings', { auth: true, body, headers: { 'idempotency-key': key } });
  expect(replay.json.replayed === true && replay.json.data.id === first.json.data.id, 'replay did not return the same booking');
  const over = await call('POST', '/v1/stays/bookings', { auth: true, body: { ...body, max_total: { amount: '1.00', currency: room.total.currency } }, headers: { 'idempotency-key': `smoke-stay-over-${randomUUID()}` } });
  expect(over.status === 409 && over.json.error.code === 'PRICE_OVER_BUDGET', `over-budget HTTP ${over.status} ${over.json?.error?.code}`);
  const status = await call('GET', `/v1/bookings/stay/${first.json.data.id}`, { auth: true });
  expect(status.status === 200 && status.json.data.status === 'CONFIRMED', `status HTTP ${status.status}`);
  return `booking ${first.json.data.id}, over-budget refused`;
}, 'booking');
await check('GET /v1/operations/:id', async () => { expect(operationId, 'no operation from the booking test'); const r = await call('GET', `/v1/operations/${operationId}`, { auth: true }); expect(r.status === 200 && r.json.state === 'succeeded', `HTTP ${r.status}`); }, 'booking');

const icon = { PASS: '✔', FAIL: '✖', SKIP: '–', BLOCKED: '⚠' } as const;
console.log(`\nSmoke test against ${base}\n`);
for (const r of results) console.log(`${icon[r.status]} ${r.status.padEnd(7)} ${r.name.padEnd(52)} ${String(r.ms).padStart(5)}ms  ${r.note}`);
const count = (s: Result['status']) => results.filter(r => r.status === s).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('BLOCKED')} blocked by external setup, ${count('SKIP')} skipped`);
process.exitCode = count('FAIL') ? 1 : 0;
