import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { masumiInputHash, masumiResultHash } from '../src/masumi.js';
import { auditPlan, type AuditRequest } from '../src/auditor.js';
import { Advisor } from '../src/providers/advisor.js';
import type { Fetch } from '../src/http.js';

const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stay = (extra: object = {}) => ({ check_in_date: future(20), check_out_date: future(23), rooms: [{ adults: 2, children_ages: [6, 9] }], location: { city: 'Cebu', country_code: 'PH' }, ...extra });
const lite = () => ({
  hotels: [{ id: 'lp1', name: 'Lite Hotel', stars: 4, rating: 8.9, city_name: 'Cebu', country_code: 'PH' }],
  data: [{ hotelId: 'lp1', roomTypes: [{ offerId: 'offer-aaaaaaaaaaaaaaaaaaaa', rates: [{ rateId: 'r1', name: 'Family', boardName: 'Room Only', adultCount: 2, childCount: 2, retailRate: { total: [{ amount: 300, currency: 'USD' }], taxesAndFees: [{ included: true }] }, cancellationPolicies: { refundableTag: 'RFN', cancelPolicyInfos: [] } }] }] }],
});
const advisorStays = () => ({ heading: 'h', stays: [{ property_id: '555', name: 'Advisor Inn', price: '$40', free_cancellation: true, url: 'https://www.hotels.com/ho1' }] });
async function fixture(env: Record<string, string> = {}, fetcher: Fetch) { return buildApp(getConfig({ DATA_PATH: ':memory:', ...env }), { fetch: fetcher, poll: false }); }

test('stay search routes: auto prefers LiteAPI with kids, falls back to the advisor, and passes hotel_ids', async t => {
  const liteBodies: any[] = []; let liteEmpty = false;
  const fetcher: Fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (String(url).includes('liteapi')) { liteBodies.push(body); return liteEmpty ? json({ code: 2001, message: 'no availability found' }, 400) : json(lite()); }
    return json(advisorStays());
  };
  const { app } = await fixture({ LITEAPI_API_KEY: 'sand_fixture', ADVISOR_URL: 'https://advisor.test' }, fetcher); t.after(() => app.close());
  const first = await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay() });
  assert.equal(first.statusCode, 200); assert.equal(first.json().provider, 'liteapi'); assert.equal(first.json().data.hotels[0].name, 'Lite Hotel');
  assert.deepEqual(liteBodies[0].occupancies, [{ adults: 2, children: [6, 9] }]);
  const withIds = await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay({ hotel_ids: ['lp1', 'lp2'], provider: 'liteapi' }) });
  assert.equal(withIds.statusCode, 200); assert.deepEqual(liteBodies[1].hotelIds, ['lp1', 'lp2']); assert.equal(liteBodies[1].cityName, undefined);
  liteEmpty = true;
  const fallback = await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay() });
  assert.equal(fallback.statusCode, 200); assert.equal(fallback.json().provider, 'advisor'); assert.equal(fallback.json().data.hotels[0].id, '555');
  const forced = await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay({ provider: 'advisor' }) });
  assert.equal(forced.json().provider, 'advisor');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay({ provider: 'nope' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay({ hotel_ids: [] }) })).statusCode, 400);
});

test('auto without an advisor and without LiteAPI results keeps the LiteAPI answer (possibly empty) and never invents hotels', async t => {
  const fetcher: Fetch = async () => json({ data: [], hotels: [] });
  const { app } = await fixture({ LITEAPI_API_KEY: 'sand_fixture' }, fetcher); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/stays/search', payload: stay() });
  assert.equal(res.statusCode, 200); assert.equal(res.json().provider, 'liteapi'); assert.deepEqual(res.json().data.hotels, []);
});

test('advisor checkout understands the deployed shape: no offer, but a pre-filled hotel page', async () => {
  const config = getConfig({ ADVISOR_URL: 'https://advisor.test' });
  const deployed = new Advisor(config, (async () => Response.json({ status: 'completed', stays: [{ property_id: '1', url: 'https://www.hotels.com/es/ho1?x=1' }], checkout_error: 'The selected stay has no offer to open' })) as typeof fetch);
  const linked = await deployed.checkout({ destination: 'Siargao', check_in: '2026-11-08', check_out: '2026-11-10', adults: 2, property_id: '1' });
  assert.equal(linked.opened, false); assert.equal(linked.link_only, true);
  assert.equal(linked.checkout_url, 'https://www.hotels.com/es/ho1?x=1'); assert.match(linked.failure_reason ?? '', /no offer/);
  const legacy = new Advisor(config, (async () => Response.json({ checkout: { trip_id: 'T1', checkout_url: 'https://pay.test/T1' } })) as typeof fetch);
  const ok = await legacy.checkout({ destination: 'Cebu', check_in: '2026-11-08', check_out: '2026-11-10', adults: 1, property_id: '1' });
  assert.equal(ok.opened, true); assert.equal(ok.link_only, false); assert.equal(ok.trip_id, 'T1');
  const bare = new Advisor(config, (async () => Response.json({ checkout_error: 'x', stays: [] })) as typeof fetch);
  const none = await bare.checkout({ destination: 'Cebu', check_in: '2026-11-08', check_out: '2026-11-10', adults: 1, property_id: '1' });
  assert.equal(none.opened, false); assert.equal(none.link_only, false); assert.equal(none.checkout_url, null);
});

// --- MIP-003 services ---
const nonce = 'aabbccddeeff0011';
const agentId = 'a'.repeat(64);
function payments() {
  const created: any[] = [];
  const fetcher: Fetch = async (url, init) => {
    const path = String(url); const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/payment')) {
      created.push(body);
      return json({ data: { ...body, payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)), unlockTime: String(Date.parse(body.unlockTime)), externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)), blockchainIdentifier: 'chain_' + created.length, SmartContractWallet: { walletVkey: 'vkey' }, PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2' } } });
    }
    return json({ data: {} });
  };
  return { created, fetcher };
}

test('start_job quotes each service at its own price and binds the exact input', async t => {
  const p = payments();
  const { app } = await fixture({ MASUMI_TOKEN: 'fixture', MASUMI_AGENT_IDENTIFIER: agentId, LITEAPI_API_KEY: 'sand_x' }, p.fetcher); t.after(() => app.close());
  const knowledge = { knowledge_request_json: JSON.stringify({ destination: 'Siargao', question: 'rainy day with kids?' }) };
  const audit = { audit_request_json: JSON.stringify({ plan_text: 'x', constraints: { nights: 2, adults: 2 }, evidence: { hotels: [] } }) };
  const k = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: nonce, input_data: knowledge } });
  assert.equal(k.statusCode, 200); assert.equal(k.json().input_hash, masumiInputHash(knowledge, nonce)); assert.equal(p.created[0].RequestedFunds[0].amount, '500000');
  const a = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: 'bbccddeeff001122', input_data: audit } });
  assert.equal(a.statusCode, 200); assert.equal(a.json().input_hash, masumiInputHash(audit, 'bbccddeeff001122')); assert.equal(p.created[1].RequestedFunds[0].amount, '500000');
  const trip = { trip_request_json: JSON.stringify({ stays: stay() }) };
  const s = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: 'ccddeeff00112233', input_data: trip } });
  assert.equal(s.statusCode, 200); assert.equal(p.created[2].RequestedFunds[0].amount, '1000000');
  // Both keys at once, or a bad body, are refused before any payment is created.
  const both = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: 'ddeeff0011223344', input_data: { ...knowledge, ...audit } } });
  assert.equal(both.statusCode, 400);
  const bad = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: 'eeff001122334455', input_data: { knowledge_request_json: '{"destination":1}' } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(p.created.length, 3);
  // Replaying the nonce with another input is a conflict.
  const clash = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: nonce, input_data: { knowledge_request_json: JSON.stringify({ destination: 'Cebu' }) } } });
  assert.equal(clash.statusCode, 409);
});

test('prices are configurable and SERVICES switches services off', async t => {
  const p = payments();
  const { app } = await fixture({ MASUMI_TOKEN: 'fixture', MASUMI_AGENT_IDENTIFIER: agentId, SERVICES: 'audit', MASUMI_AUDIT_PRICE_ATOMIC: '250000' }, p.fetcher); t.after(() => app.close());
  const knowledge = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: nonce, input_data: { knowledge_request_json: JSON.stringify({ destination: 'Cebu' }) } } });
  assert.equal(knowledge.statusCode, 404); assert.equal(knowledge.json().error.code, 'SERVICE_NOT_OFFERED');
  const audit = await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: nonce, input_data: { audit_request_json: JSON.stringify({ plan_text: 'x', constraints: { nights: 1, adults: 1 }, evidence: { hotels: [] } }) } } });
  assert.equal(audit.statusCode, 200); assert.equal(p.created[0].RequestedFunds[0].amount, '250000');
  const schema = (await app.inject('/input_schema')).json();
  assert.deepEqual(schema.input_data.map((f: any) => f.id), ['audit_request_json']);
  assert.equal((await app.inject('/availability')).json().services.join(), 'audit');
});

test('input_schema lists the primary field first and the other services as optional', async t => {
  const { app } = await fixture({}, async () => json({})); t.after(() => app.close());
  const schema = (await app.inject('/input_schema')).json();
  assert.deepEqual(schema.input_data.map((f: any) => f.id), ['trip_request_json', 'knowledge_request_json', 'audit_request_json']);
  assert.ok(schema.input_data[1].validations.some((v: any) => v.validation === 'optional'));
  assert.ok(!schema.input_data[0].validations.some((v: any) => v.validation === 'optional'));
});

test('simulated knowledge and audit jobs run the whole paid flow and commit a result hash', async t => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Siargao in November has showers; the Magpupungko tidal pools are a rainy-day-friendly sight.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) as any });
  const { app, masumi } = await buildApp(getConfig({ DATA_PATH: ':memory:', MASUMI_MODE: 'simulated', OPENROUTER_API_KEY: 'k' }), { fetch: async () => json({}), poll: false, model } as any); t.after(() => app.close());
  const run = async (n: string, input: object) => {
    const started = (await app.inject({ method: 'POST', url: '/start_job', payload: { identifier_from_purchaser: n, input_data: input } })).json();
    await app.inject({ method: 'POST', url: '/v1/demo/simulate-payment', payload: { job_id: started.id } });
    await masumi.tick(); await masumi.tick();
    return { started, done: (await app.inject(`/status?job_id=${started.id}`)).json() };
  };
  const k = await run('1122334455667788', { knowledge_request_json: JSON.stringify({ destination: 'Siargao', question: 'rainy day with kids?' }) });
  assert.equal(k.done.status, 'completed'); assert.equal(JSON.parse(k.done.result).destination, 'Siargao'); assert.match(JSON.parse(k.done.result).answer, /Magpupungko/);
  assert.equal(k.done.result_hash, masumiResultHash(k.done.result, '1122334455667788'));
  const a = await run('2233445566778899', { audit_request_json: JSON.stringify({ plan_text: 'Stay at Lite Hotel for 300 USD.', constraints: { nights: 3, adults: 2 }, evidence: { hotels: [{ name: 'Lite Hotel', total: 300, currency: 'USD' }] } }) });
  assert.equal(a.done.status, 'completed'); assert.equal(JSON.parse(a.done.result).verdict, 'pass');
  assert.equal(a.done.result_hash, masumiResultHash(a.done.result, '2233445566778899'));
});

// --- auditor ---
const request = (over: Partial<AuditRequest> = {}): AuditRequest => ({
  plan_text: 'Top pick: **Fili Hotel Cebu**, 330 USD total for 3 nights (110 USD per night), free cancellation. Party: 2 adults and 2 children (6, 9). Alternative: Cebu Parklane International Hotel, 390 USD.',
  constraints: { nights: 3, adults: 2, children_ages: [6, 9], budget_per_night: 150, currency: 'USD' },
  evidence: { hotels: [{ name: 'Fili Hotel Cebu', total: 330, nightly: 110, currency: 'USD', free_cancellation: true }, { name: 'Cebu Parklane International Hotel', total: 390, nightly: 130, currency: 'USD' }], knowledge: ['Cebu has Magellan\'s Cross and Basilica del Santo Nino.'] },
  ...over,
});

test('auditor passes a grounded plan with rules alone', async () => {
  const r = await auditPlan(getConfig({}), request());
  assert.equal(r.verdict, 'pass'); assert.equal(r.method, 'rules');
  assert.ok(Object.values(r.checks).every(Boolean)); assert.ok(r.claims.length > 0 && r.claims.length <= 20);
});

test('auditor flags an unknown hotel, a price that is not in the evidence and unstated kids', async () => {
  const r = await auditPlan(getConfig({}), request({ plan_text: 'Top pick: **Grand Imaginary Resort**, 999 USD total for 3 nights. Party: 2 adults.' }));
  assert.equal(r.verdict, 'revise'); assert.equal(r.checks.hotels_known, false); assert.equal(r.checks.prices_match, false); assert.equal(r.checks.occupancy_stated, false);
  assert.ok(r.claims.some(c => c.status === 'unsupported' && /Grand Imaginary/.test(c.claim)));
  assert.ok(r.rewrite_hints.length >= 1);
});

test('auditor flags a top pick over the nightly budget unless the plan says so', async () => {
  const tight = request({ constraints: { ...request().constraints, budget_per_night: 100 } });
  const over = await auditPlan(getConfig({}), tight);
  assert.equal(over.verdict, 'revise'); assert.equal(over.checks.budget_ok, false);
  assert.ok(over.claims.some(c => c.status === 'unsupported' && /Fili Hotel Cebu/.test(c.claim)));
  const flagged = await auditPlan(getConfig({}), request({ constraints: tight.constraints, plan_text: request().plan_text.replace('free cancellation.', 'free cancellation. Fili Hotel Cebu is over your budget of 100 per night, so I list it only as the best fit.') }));
  assert.equal(flagged.checks.budget_ok, true);
});

test('auditor accepts nights x nightly as a derived price and a kids phrasing variant', async () => {
  const r = await auditPlan(getConfig({}), request({ plan_text: 'Stay at Fili Hotel Cebu: 110 USD per night, 330 USD for 3 nights. Travelling with two kids (ages 6 and 9) and 2 adults.' }));
  assert.equal(r.verdict, 'pass');
});

test('auditor model pass flags ungrounded places and degrades to rules on failure', async () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } as any;
  const say = (text: string) => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) as any });
  const plan = request({ plan_text: request().plan_text + ' Day 2: Siargao Museum and the Cebu mini-zoo.' });
  const flagged = await auditPlan(getConfig({ OPENROUTER_API_KEY: 'k' }), plan, say(JSON.stringify({ places: [{ place: 'Siargao Museum', grounded: false, note: 'not in the knowledge desk answer' }, { place: "Magellan's Cross", grounded: true }] })));
  assert.equal(flagged.method, 'rules+model'); assert.equal(flagged.verdict, 'revise'); assert.equal(flagged.checks.places_grounded, false);
  assert.ok(flagged.claims.some(c => c.status === 'unsupported' && /Siargao Museum/.test(c.claim)));
  const broken = await auditPlan(getConfig({ OPENROUTER_API_KEY: 'k' }), plan, say('not json'));
  assert.equal(broken.method, 'rules'); assert.equal(broken.checks.places_grounded, true);
  const throwing = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('rate limit'); } });
  assert.equal((await auditPlan(getConfig({ OPENROUTER_API_KEY: 'k' }), plan, throwing)).method, 'rules');
});

test('auditor input is validated and bounded', async () => {
  await assert.rejects(auditPlan(getConfig({}), { plan_text: '', constraints: { nights: 1, adults: 1 }, evidence: { hotels: [] } } as any));
});
