import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { masumiInputHash, masumiResultHash } from '../src/masumi.js';
import { sha256 } from '../src/store.js';
import { requireBudget } from '../src/money.js';
import type { Fetch } from '../src/http.js';

const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const flightInput = () => ({ slices: [{ origin: 'SIN', destination: 'BKK', departure_date: future(20) }], passengers: [{ type: 'adult' }] });
const stayInput = () => ({ check_in_date: future(20), check_out_date: future(23), rooms: [{ adults: 2 }], location: { city: 'Singapore', country_code: 'SG' } });
const passenger = { id: 'pas_1', given_name: 'Test', family_name: 'Traveler', born_on: '1990-01-01', gender: 'm', title: 'mr', email: 'test@example.com', phone_number: '+6591234567' };
const flightBooking = () => ({ offer_id: 'off_1', passengers: [passenger], max_total: { amount: '200.00', currency: 'USD' }, confirm: true });
const offer = (overrides: object = {}) => ({ id: 'off_1', total_amount: '180.00', total_currency: 'USD', live_mode: false, passengers: [{ id: 'pas_1' }], expires_at: new Date(Date.now() + 600000).toISOString(), ...overrides });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noNetwork: Fetch = async () => { throw new Error('Unexpected network access'); };
async function fixture(env: Record<string, string> = {}, fetcher: Fetch = noNetwork) { return buildApp(getConfig({ DATA_PATH: ':memory:', FLIGHTS_ENABLED: 'true', ...env }), { fetch: fetcher, poll: false }); }

test('demo supports flight and hotel search, flight booking, and idempotent replay', async t => {
  const { app } = await fixture({ TRAVEL_MODE: 'demo' }); t.after(() => app.close());
  const trip = await app.inject({ method: 'POST', url: '/v1/trips/search', payload: { flights: flightInput(), stays: stayInput() } });
  assert.equal(trip.statusCode, 200); assert.equal(trip.json().complete, true);
  assert.equal(trip.json().results.stays.data.hotels[0].rooms[0].total.currency, 'USD');
  const selected = trip.json().results.flights.data.offers[0];
  const body = { ...flightBooking(), offer_id: selected.id, passengers: [{ ...passenger, id: selected.passengers[0].id }] };
  const booking = await app.inject({ method: 'POST', url: '/v1/flights/bookings', headers: { 'idempotency-key': 'demo-flight-1' }, payload: body });
  assert.equal(booking.statusCode, 200); assert.equal(booking.json().data.status, 'simulated');
  const replay = await app.inject({ method: 'POST', url: '/v1/flights/bookings', headers: { 'idempotency-key': 'demo-flight-1' }, payload: body });
  assert.equal(replay.json().data.id, booking.json().data.id); assert.equal(replay.json().replayed, true);
});

test('live mode reports missing credentials and keeps partial search failures visible', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const flights = await app.inject({ method: 'POST', url: '/v1/flights/search', payload: flightInput() });
  assert.equal(flights.statusCode, 503); assert.equal(flights.json().error.code, 'PROVIDER_NOT_CONFIGURED');
  const trip = await app.inject({ method: 'POST', url: '/v1/trips/search', payload: { flights: flightInput(), stays: stayInput() } });
  assert.equal(trip.json().complete, false); assert.equal(trip.json().results.flights.status, 'error'); assert.equal(trip.json().results.stays.error.code, 'PROVIDER_NOT_CONFIGURED');
});

test('dates, empty requests, confirmation, and idempotency headers are validated', async t => {
  const { app } = await fixture({ TRAVEL_MODE: 'demo' }); t.after(() => app.close());
  for (const payload of [{}, { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: '2020-01-01' }], passengers: [{ type: 'adult' }] }, { ...flightInput(), unrecognized: true }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/flights/search', payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/trips/search', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flights/bookings', payload: flightBooking() })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flights/bookings', headers: { 'idempotency-key': 'validate-1' }, payload: { ...flightBooking(), confirm: false } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/stays/search', payload: { ...stayInput(), check_out_date: future(10) } })).statusCode, 400);
});

test('supplier requests use the documented Duffel and LiteAPI wrappers and headers', async t => {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    return response(String(url).includes('duffel') ? { data: { offers: [] } } : {
      hotels: [{ id: 'lp1', name: 'Test Hotel', stars: 4, city_name: 'Singapore', country_code: 'SG' }],
      data: [{ hotelId: 'lp1', roomTypes: [{ offerId: 'offer-1', rates: [
        { rateId: 'rate-2', name: 'Pricey', boardName: 'Room Only', adultCount: 2, childCount: 0, retailRate: { total: [{ amount: 300, currency: 'USD' }], taxesAndFees: [{ included: true }] }, cancellationPolicies: { refundableTag: 'NRFN', cancelPolicyInfos: [] } },
        { rateId: 'rate-1', name: 'Cheap', boardName: 'Breakfast Included', adultCount: 2, childCount: 0, retailRate: { total: [{ amount: 200, currency: 'USD' }], taxesAndFees: [{ included: true }] }, cancellationPolicies: { refundableTag: 'RFN', cancelPolicyInfos: [{ cancelTime: '2030-01-01 00:00:00' }] } },
      ] }] }],
    });
  };
  const { app } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', LITEAPI_API_KEY: 'sand_fixture' }, fetcher); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flights/search', payload: flightInput() })).statusCode, 200);
  assert.equal(calls[0].url, 'https://api.duffel.com/air/offer_requests?return_offers=true');
  assert.equal(calls[0].headers.get('duffel-version'), 'v2'); assert.equal(calls[0].body.data.slices[0].origin, 'SIN');
  const stays = await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stayInput() });
  assert.equal(stays.statusCode, 200);
  assert.equal(calls[1].url, 'https://api.liteapi.travel/v3.0/hotels/rates');
  assert.equal(calls[1].headers.get('x-api-key'), 'sand_fixture');
  assert.deepEqual(calls[1].body.occupancies, [{ adults: 2, children: [] }]);
  assert.equal(calls[1].body.cityName, 'Singapore'); assert.equal(calls[1].body.countryCode, 'SG');
  const hotel = stays.json().data.hotels[0];
  assert.equal(stays.json().environment, 'sandbox'); assert.equal(hotel.name, 'Test Hotel');
  assert.equal(hotel.rooms[0].rate_id, 'rate-1'); assert.equal(hotel.rooms[0].refundable, true); assert.deepEqual(hotel.cheapest_total, { amount: '200', currency: 'USD' });
});

test('flight booking refreshes price and blocks price increases, expired offers, wrong passengers, and live tokens', async t => {
  for (const [override, expectedCode] of [[{ total_amount: '201.00' }, 'PRICE_OVER_BUDGET'], [{ total_currency: 'SGD' }, 'CURRENCY_CHANGED'], [{ expires_at: '2020-01-01T00:00:00Z' }, 'QUOTE_EXPIRED'], [{ passengers: [{ id: 'pas_other' }] }, 'PASSENGER_MISMATCH']] as const) {
    let posts = 0;
    const { app } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', FLIGHTS_ENABLED: 'true' }, async (url, init) => { if (init?.method === 'POST') posts++; return response({ data: offer(override) }); });
    const res = await app.inject({ method: 'POST', url: '/v1/flights/bookings', headers: { 'idempotency-key': 'budget-check-1' }, payload: flightBooking() });
    assert.equal(res.json().error.code, expectedCode); assert.equal(posts, 0); await app.close();
  }
  const { app } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_live_fixture' }); t.after(() => app.close());
  const live = await app.inject({ method: 'POST', url: '/v1/flights/bookings', headers: { 'idempotency-key': 'live-disabled-1' }, payload: flightBooking() });
  assert.equal(live.statusCode, 403); assert.equal(live.json().error.code, 'LIVE_BOOKINGS_DISABLED');
});

test('uncertain booking survives a restart and blocks automatic resubmission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'origin-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let posts = 0;
  const fetcher: Fetch = async (url, init) => {
    if (init?.method === 'POST') { posts++; throw new Error('Connection dropped after order submission'); }
    return response({ data: offer() });
  };
  const config = getConfig({ DATA_PATH: join(directory, 'journal.sqlite'), DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', FLIGHTS_ENABLED: 'true' });
  let server = await buildApp(config, { fetch: fetcher, poll: false });
  const req = { method: 'POST' as const, url: '/v1/flights/bookings', headers: { 'idempotency-key': 'persistent-booking-1' }, payload: flightBooking() };
  const first = await server.app.inject(req); assert.equal(first.statusCode, 504); assert.equal(first.json().error.details.state, 'uncertain');
  await server.app.close(); server = await buildApp(config, { fetch: fetcher, poll: false }); t.after(() => server.app.close());
  const repeated = await server.app.inject(req); assert.equal(repeated.statusCode, 409); assert.equal(posts, 1);
  const saved = await server.app.inject(`/v1/operations/${first.json().error.details.operation_id}`); assert.equal(saved.json().state, 'uncertain');
});

test('concurrent booking requests do not create two supplier orders', async t => {
  let posts = 0;
  const { app } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', FLIGHTS_ENABLED: 'true' }, async (url, init) => {
    if (init?.method === 'POST') { posts++; return response({ data: { id: 'ord_1', booking_reference: 'TEST00', live_mode: false } }); }
    return response({ data: offer() });
  }); t.after(() => app.close());
  const req = { method: 'POST' as const, url: '/v1/flights/bookings', headers: { 'idempotency-key': 'concurrent-booking-1' }, payload: flightBooking() };
  const results = await Promise.all([app.inject(req), app.inject(req)]);
  assert.equal(posts, 1); assert.ok(results.some(r => r.statusCode === 200));
  const changed = await app.inject({ ...req, payload: { ...flightBooking(), max_total: { amount: '220', currency: 'USD' } } });
  assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT');
});

test('authenticated routes include docs, while health stays public', async t => {
  const { app } = await fixture({ API_KEY: 'test-server-token', TRAVEL_MODE: 'demo' }); t.after(() => app.close());
  assert.equal((await app.inject('/v1/capabilities')).statusCode, 401);
  assert.equal((await app.inject('/docs')).statusCode, 401);
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/availability')).statusCode, 200);
  assert.equal((await app.inject('/input_schema')).statusCode, 200);
  assert.equal((await app.inject('/status?job_id=00000000-0000-4000-8000-000000000000')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: '0123456789abcdef', input_data: { trip_request_json: '{}' } } })).statusCode, 503);
  assert.equal((await app.inject({ url: '/v1/capabilities', headers: { authorization: 'Bearer test-server-token' } })).statusCode, 200);
  assert.throws(() => getConfig({ HOST: '0.0.0.0' }), /API_KEY/);
});

test('supplier errors never return traveler fields or supplier secrets', async t => {
  const { app } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', FLIGHTS_ENABLED: 'true' }, async () => response({ errors: [{ code: 'invalid_offer', message: 'Secret and traveler test@example.com' }] }, 422)); t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url: '/v1/flights/search', payload: flightInput() });
  assert.equal(result.statusCode, 502); assert.ok(!result.body.includes('test@example.com')); assert.ok(!result.body.includes('Secret'));
});

test('hackathon public search exposes docs and search while protecting bookings', async t => {
  const { app } = await fixture({ API_KEY: 'test-server-token', PUBLIC_SEARCH: 'true', TRAVEL_MODE: 'demo' }); t.after(() => app.close());
  assert.equal((await app.inject('/docs/')).statusCode, 200);
  assert.equal((await app.inject('/v1/capabilities')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flights/search', payload: flightInput() })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flights/bookings', payload: flightBooking() })).statusCode, 401);
  assert.equal((await app.inject('/v1/flights/offers/off_missing')).statusCode, 404);
  assert.equal((await app.inject('/v1/operations/00000000-0000-4000-8000-000000000000')).statusCode, 401);
  assert.equal((await app.inject('/internal/masumi/tick')).statusCode, 401);
  const spec = (await app.inject('/openapi.json')).json();
  assert.deepEqual(spec.paths['/v1/flights/search'].post.security, []);
});

test('decimal budget comparison has no floating-point rounding', () => {
  requireBudget('0.300000', 'USD', { amount: '0.3', currency: 'USD' });
  assert.throws(() => requireBudget('0.300001', 'USD', { amount: '0.3', currency: 'USD' }), /exceeds/);
});

test('Masumi input and result hashes bind exact bytes to the purchaser nonce', () => {
  const nonce = 'aabbccddeeff0011';
  const input = { trip_request_json: '{"city":"Bangkok"}' };
  assert.equal(masumiInputHash(input, nonce), sha256(nonce + ';' + JSON.stringify(input)));
  const result = 'quote "test"\npath \\ airport';
  assert.equal(masumiResultHash(result, nonce), sha256(nonce + ';' + result));
  assert.notEqual(masumiResultHash(result, nonce), masumiResultHash(result + '\n', nonce));
});

test('Masumi paid search waits for confirmed funds and confirmed result submission', async t => {
  let state: string | null = null, confirmed = false, submittedHash: string | undefined;
  let searches = 0, paymentCreates = 0;
  const nonce = 'aabbccddeeff0011', agentId = 'a'.repeat(64);
  const input = { trip_request_json: JSON.stringify({ flights: flightInput() }) };
  let savedPayment: any;
  const fetcher: Fetch = async (url, init) => {
    const path = String(url); const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.includes('duffel.com')) { searches++; return response({ data: { offers: [offer()] } }); }
    if (path.endsWith('/payment')) {
      paymentCreates++;
      savedPayment = { ...body, payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)), unlockTime: String(Date.parse(body.unlockTime)), externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)), blockchainIdentifier: 'chain_test', SmartContractWallet: { walletVkey: 'vkey' }, PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2' } };
      return response({ data: savedPayment });
    }
    if (path.endsWith('/payment/submit-result')) { submittedHash = body.submitResultHash; return response({ data: {} }); }
    return response({ data: { onChainState: state, resultHash: submittedHash, CurrentTransaction: { status: confirmed ? 'Confirmed' : 'Pending', newOnChainState: state } } });
  };
  const { app, masumi } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', MASUMI_TOKEN: 'fixture', MASUMI_AGENT_IDENTIFIER: agentId }, fetcher); t.after(() => app.close());
  const request = { method: 'POST' as const, url: '/start_job', payload: { identifier_from_purchaser: nonce, input_data: input } };
  const started = await app.inject(request); assert.equal(started.statusCode, 200); assert.equal(started.json().input_hash, masumiInputHash(input, nonce));
  assert.equal((await app.inject(request)).json().id, started.json().id); assert.equal(paymentCreates, 1);
  await masumi.tick(); assert.equal(searches, 0);
  state = 'FundsLocked'; await masumi.tick(); assert.equal(searches, 0);
  confirmed = true; await masumi.tick(); assert.equal(searches, 1); assert.ok(submittedHash);
  assert.equal((await app.inject(`/status?job_id=${started.json().id}`)).json().status, 'running');
  state = 'ResultSubmitted'; await masumi.tick();
  const completed = await app.inject(`/status?job_id=${started.json().id}`); assert.equal(completed.json().status, 'completed');
  assert.equal(submittedHash, masumiResultHash(completed.json().result, nonce));
  assert.equal(completed.json().seller_receipt_verified, false);
});

test('OpenAPI lists every implemented travel and Masumi operation', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const spec = (await app.inject('/openapi.json')).json();
  assert.ok(spec.paths['/v1/flights/search'].post.requestBody);
  assert.ok(spec.paths['/v1/stays/search'].post.requestBody);
  assert.equal(spec.paths['/v1/activities/search'], undefined);
  assert.ok(spec.paths['/start_job'].post.requestBody);
  assert.equal((await app.inject('/docs/')).statusCode, 200);
});

test('plain-text supplier access errors keep HTTP status and do not expose the body', async () => {
  const { HttpClient } = await import('../src/http.js');
  const client = new HttpClient(1000, async () => new Response('Private account information', { status: 403 }));
  await assert.rejects(client.request('https://supplier.example', '/search', {}), (error: any) => {
    assert.equal(error.code, 'UPSTREAM_REJECTED');
    assert.equal(error.details.upstream_status, 403);
    assert.equal(error.uncertain, false);
    assert.ok(!JSON.stringify(error).includes('Private account'));
    return true;
  });
});

const liteResponse = () => ({
  hotels: [{ id: 'lp1', name: 'Test Hotel', stars: 4, rating: 8.8, city_name: 'Bangkok', country_code: 'TH' }, { id: 'lp2', name: 'Budget Inn', stars: 2, rating: 7.1, city_name: 'Bangkok', country_code: 'TH' }],
  data: [
    { hotelId: 'lp1', roomTypes: [{ offerId: 'o1', rates: [{ rateId: 'r1', name: 'King', boardName: 'Room Only', adultCount: 1, childCount: 0, retailRate: { total: [{ amount: 300, currency: 'USD' }], taxesAndFees: [{ included: true }] }, cancellationPolicies: { refundableTag: 'RFN', cancelPolicyInfos: [] } }] }] },
    { hotelId: 'lp2', roomTypes: [{ offerId: 'o2', rates: [{ rateId: 'r2', name: 'Twin', boardName: 'Room Only', adultCount: 1, childCount: 0, retailRate: { total: [{ amount: 90, currency: 'USD' }], taxesAndFees: [] }, cancellationPolicies: { refundableTag: 'NRFN', cancelPolicyInfos: [] } }] }] },
  ],
});
const duffelOffers = () => ({ data: { offers: [
  { id: 'off_a', total_amount: '120.00', total_currency: 'USD', owner: { name: 'Slow Air' }, slices: [{ duration: 'PT5H10M', origin: { iata_code: 'SIN' }, destination: { iata_code: 'BKK' }, segments: [{ departing_at: '2030-01-01T08:00:00', arriving_at: '2030-01-01T09:00:00' }, { departing_at: '2030-01-01T10:00:00', arriving_at: '2030-01-01T13:10:00' }] }] },
  { id: 'off_b', total_amount: '180.00', total_currency: 'USD', owner: { name: 'Fast Air' }, slices: [{ duration: 'PT2H25M', origin: { iata_code: 'SIN' }, destination: { iata_code: 'BKK' }, segments: [{ departing_at: '2030-01-01T08:00:00', arriving_at: '2030-01-01T10:25:00' }] }] },
] } });
const tripRequest = () => ({ flights: flightInput(), stays: { ...stayInput(), location: { city: 'Bangkok', country_code: 'TH' } } });
const supplierFetch: Fetch = async url => response(String(url).includes('duffel') ? duffelOffers() : liteResponse());

test('trip summary picks cheapest and fastest flights and top-rated hotels without mixing currencies', async t => {
  const { app } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', LITEAPI_API_KEY: 'sand_fixture' }, supplierFetch); t.after(() => app.close());
  const trip = (await app.inject({ method: 'POST', url: '/v1/trips/search', payload: tripRequest() })).json();
  assert.equal(trip.complete, true);
  const { flights, hotels, estimated_total } = trip.summary;
  assert.equal(flights.cheapest.airline, 'Slow Air'); assert.equal(flights.cheapest.stops, 1);
  assert.equal(flights.fastest.airline, 'Fast Air'); assert.equal(flights.fastest.duration_minutes, 145);
  assert.equal(hotels.top_rated[0].name, 'Test Hotel'); assert.equal(hotels.top_rated[0].refundable, true);
  assert.equal(hotels.cheapest.name, 'Budget Inn');
  assert.deepEqual(estimated_total, { amount: '210.00', currency: 'USD', basis: 'cheapest flight + cheapest hotel' });
});

test('simulated rehearsal runs the whole paid flow, stays labelled, and verifies both hashes', async t => {
  const { app, masumi } = await fixture({ DUFFEL_ACCESS_TOKEN: 'duffel_test_fixture', LITEAPI_API_KEY: 'sand_fixture', MASUMI_MODE: 'simulated' }, supplierFetch); t.after(() => app.close());
  assert.equal((await app.inject('/availability')).json().status, 'unavailable');
  assert.equal((await app.inject('/v1/capabilities')).json().masumi.mode, 'simulated');
  const nonce = 'abcdef0123456789abcd';
  const input = { trip_request_json: JSON.stringify(tripRequest()) };
  const started = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: nonce, input_data: input } });
  assert.equal(started.statusCode, 200);
  const job = started.json();
  assert.equal(job.settlement, 'simulated'); assert.ok(job.blockchainIdentifier.startsWith('sim_'));
  assert.equal(job.input_hash, masumiInputHash(input, nonce));
  // Funds are not locked yet, so no supplier work may run.
  await masumi.tick();
  assert.equal((await app.inject(`/status?job_id=${job.id}`)).json().status, 'awaiting_payment');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/demo/simulate-payment', payload: { job_id: job.id } })).statusCode, 200);
  await masumi.tick();
  const mid = (await app.inject(`/status?job_id=${job.id}`)).json();
  assert.equal(mid.phase, 'awaiting_result'); assert.ok(mid.transactions.payment.startsWith('sim-'));
  await masumi.tick();
  const done = (await app.inject(`/status?job_id=${job.id}`)).json();
  assert.equal(done.status, 'completed'); assert.equal(done.settlement, 'simulated');
  assert.equal(done.result_hash, masumiResultHash(done.result, nonce)); assert.equal(done.input_hash, masumiInputHash(input, nonce));
  assert.ok(done.transactions.result.startsWith('sim-'));
  assert.equal(JSON.parse(done.result).summary.flights.cheapest.airline, 'Slow Air');
  // A second payment attempt is refused once funds are locked.
  assert.equal((await app.inject({ method: 'POST', url: '/v1/demo/simulate-payment', payload: { job_id: job.id } })).statusCode, 409);
});

test('simulated payments are refused outside rehearsal mode', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/demo/simulate-payment', payload: { job_id: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(res.statusCode, 409); assert.equal(res.json().error.code, 'SIMULATION_DISABLED');
});

test('MIP-003 demo endpoint and the demo page are public', async t => {
  const { app } = await fixture({ API_KEY: 'test-server-token' }); t.after(() => app.close());
  const demo = await app.inject('/demo');
  assert.equal(demo.statusCode, 200);
  assert.doesNotThrow(() => JSON.parse(demo.json().input.trip_request_json)); assert.equal(typeof demo.json().output.result, 'string');
  const page = await app.inject('/demo-ui');
  assert.equal(page.statusCode, 200); assert.match(page.headers['content-type'] as string, /text\/html/); assert.match(page.body, /Origin Travel Agent/);
});

const OFFER_ID = 'A'.repeat(40);
const stayBookBody = (overrides: object = {}) => ({ offer_id: OFFER_ID, guests: [{ given_name: 'Test', family_name: 'Traveler', email: 'test@example.com' }], max_total: { amount: '420.00', currency: 'EUR' }, confirm: true, ...overrides });
const liteBookingFetch = (calls: { url: string; body: any }[], prebook: object = {}): Fetch => async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (String(url).endsWith('/rates/prebook')) return response({ data: { prebookId: 'pre_1', currency: 'EUR', price: 400.68, sellingPriceToUser: 400.68, cancellationChanged: false, boardChanged: false, paymentTypes: ['NUITEE_PAY', 'WALLET'], ...prebook } });
  if (String(url).endsWith('/rates/book')) return response({ data: { bookingId: 'bk_1', status: 'CONFIRMED', hotelConfirmationCode: 'test', checkin: '2030-01-01', checkout: '2030-01-04', hotel: { name: 'Test Hotel' } } });
  return response({ data: { bookingId: 'bk_1', status: 'CONFIRMED', hotelConfirmationCode: 'test', hotel: { name: 'Test Hotel' }, checkin: '2030-01-01', checkout: '2030-01-04' } });
};

test('hotel booking prebooks, enforces the budget, journals before booking, and replays idempotently', async t => {
  const calls: { url: string; body: any }[] = [];
  const { app } = await fixture({ LITEAPI_API_KEY: 'sand_fixture', API_KEY: 'test-server-token' }, liteBookingFetch(calls)); t.after(() => app.close());
  const auth = { authorization: 'Bearer test-server-token' };
  const post = (key: string, payload: object) => app.inject({ method: 'POST', url: '/v1/stays/bookings', headers: { ...auth, 'idempotency-key': key }, payload });
  const first = await post('stay-book-1', stayBookBody());
  assert.equal(first.statusCode, 200); assert.equal(first.json().data.id, 'bk_1'); assert.equal(first.json().data.status, 'CONFIRMED'); assert.equal(first.json().data.total.amount, '400.68');
  assert.deepEqual(calls.map(c => c.url.split('/').slice(-2).join('/')), ['rates/prebook', 'rates/book']);
  assert.equal(calls[1].body.payment.method, 'WALLET'); assert.equal(calls[1].body.prebookId, 'pre_1'); assert.equal(calls[1].body.clientReference, first.json().operation_id);
  const replay = await post('stay-book-1', stayBookBody());
  assert.equal(replay.json().replayed, true); assert.equal(calls.length, 2);
  const status = await app.inject({ url: '/v1/bookings/stay/bk_1', headers: auth });
  assert.equal(status.statusCode, 200); assert.equal(status.json().data.confirmation_code, 'test');
});

test('hotel booking refuses over-budget, changed rates, and missing confirmation before any booking call', async t => {
  const auth = { authorization: 'Bearer test-server-token' };
  for (const [prebook, body, code] of [[{}, stayBookBody({ max_total: { amount: '300.00', currency: 'EUR' } }), 'PRICE_OVER_BUDGET'], [{ cancellationChanged: true }, stayBookBody(), 'RATE_CHANGED'], [{}, stayBookBody({ confirm: false }), 'INVALID_REQUEST']] as const) {
    const calls: { url: string; body: any }[] = [];
    const { app } = await fixture({ LITEAPI_API_KEY: 'sand_fixture', API_KEY: 'test-server-token' }, liteBookingFetch(calls, prebook)); t.after(() => app.close());
    const res = await app.inject({ method: 'POST', url: '/v1/stays/bookings', headers: { ...auth, 'idempotency-key': `stay-refuse-${code}` }, payload: body });
    assert.equal(res.json().error.code, code, JSON.stringify(res.json()));
    assert.ok(!calls.some(c => c.url.endsWith('/rates/book')));
  }
});

test('hotel booking is blocked for a live LiteAPI key unless live bookings are allowed', async t => {
  const calls: { url: string; body: any }[] = [];
  const { app } = await fixture({ LITEAPI_API_KEY: 'prod_fixture', API_KEY: 'test-server-token' }, liteBookingFetch(calls)); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/stays/bookings', headers: { authorization: 'Bearer test-server-token', 'idempotency-key': 'stay-live-1' }, payload: stayBookBody() });
  assert.equal(res.json().error.code, 'LIVE_BOOKINGS_DISABLED'); assert.equal(calls.length, 0);
});

test('hotel details normalise photos, facilities, and review highlights and are public search data', async t => {
  const fetcher: Fetch = async url => {
    assert.ok(String(url).startsWith('https://api.liteapi.travel/v3.0/data/hotel?hotelId=lp1'));
    return response({ data: { id: 'lp1', name: 'Test Hotel', starRating: 5, rating: 9.1, reviewCount: 120, hotelDescription: '<p><strong>Nice</strong> &amp; calm<br>stay</p>', address: '1 Road', city: 'Bangkok', country: 'th', location: { latitude: 13.7, longitude: 100.5 },
      hotelImages: Array.from({ length: 12 }, (_, i) => ({ url: `https://img/${i}.jpg`, urlHd: `https://img/hd${i}.jpg`, caption: '' })), hotelFacilities: ['WiFi available', 'Pool'],
      checkinCheckoutTimes: { checkin_start: '03:00 PM', checkout: '11:00 AM' }, petsAllowed: false, childAllowed: true, sentiment_analysis: { pros: ['Friendly staff'], cons: ['Noisy'], categories: [] } } });
  };
  const { app } = await fixture({ LITEAPI_API_KEY: 'sand_fixture', API_KEY: 'test-server-token', PUBLIC_SEARCH: 'true' }, fetcher); t.after(() => app.close());
  const res = await app.inject('/v1/stays/hotels/lp1');
  assert.equal(res.statusCode, 200);
  const d = res.json().data;
  assert.equal(d.description, 'Nice & calm stay'); assert.equal(d.photos.length, 8); assert.equal(d.photos[0].url, 'https://img/hd0.jpg');
  assert.deepEqual(d.review_highlights, { pros: ['Friendly staff'], cons: ['Noisy'] }); assert.equal(d.check_in_from, '03:00 PM'); assert.equal(d.stars, 5);
});

test('hotel details report a missing hotel as 404', async t => {
  const { app } = await fixture({ LITEAPI_API_KEY: 'sand_fixture' , API_KEY: 'k'.repeat(8) }, async () => response({ data: null })); t.after(() => app.close());
  const res = await app.inject({ url: '/v1/stays/hotels/nope', headers: { authorization: 'Bearer kkkkkkkk' } });
  assert.equal(res.statusCode, 404); assert.equal(res.json().error.code, 'HOTEL_NOT_FOUND');
});
