import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sokosumi } from '../src/sokosumi.js';
import { Store } from '../src/store.js';
import { getConfig } from '../src/config.js';
import type { Travel } from '../src/travel.js';
import { buildPlan, savePlan } from '../src/planner.js';
import { MockLanguageModelV4 } from 'ai/test';

const coworker = '01a11100-48ed-74a7-b050-f616bc9751d6';
const id = '01a11103-ed45-7068-b0c6-2ffc923a8fd7';
const config = getConfig({ FLIGHTS_ENABLED: 'true', SOKOSUMI_COWORKER_ID: coworker, SOKOSUMI_COWORKER_API_KEY: 'coworker_test_runtime_secret' });
function fixture(failCompletion = false, invalid = false) {
  const task: any = { id, assigneeId: coworker, organizationId: null, ownerId: 'owner', workspace: { id: 'workspace' }, status: 'READY', description: invalid ? 'Find flights' : JSON.stringify({ flights: { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: '2099-11-10' }], passengers: [{ type: 'adult' }] } }) };
  const events: any[] = [];
  let searches = 0;
  const travel = { trip: async () => { searches++; return { complete: true, observed_at: 'now', results: { flights: { provider: 'duffel', environment: 'sandbox' } }, summary: {} }; } } as unknown as Travel;
  const request = (async (url: string, options: RequestInit) => {
    assert.equal((options.headers as any).Authorization, 'Bearer coworker_test_runtime_secret');
    if (url.endsWith('/coworkers/me')) return Response.json({ data: { id: coworker, archivedAt: null, capabilities: ['tasks'] } });
    if (url.includes('/workspaces/')) { assert.equal((options.headers as any)['X-Context-User-Id'], 'owner'); return Response.json({ data: { organizationId: null } }); }
    if (url.includes(`/tasks/${id}/events`)) {
      if (options.method === 'GET') return Response.json({ data: events });
      const body = JSON.parse(String(options.body));
      const event = { ...body, id: `event-${events.length}`, taskId: id, actor: { id: coworker } };
      events.push(event); if (body.status) task.status = body.status;
      if (body.status === 'COMPLETED' && failCompletion) throw new Error('Connection lost after successful write');
      return Response.json({ data: event });
    }
    if (url.endsWith(`/tasks/${id}`)) return Response.json({ data: task });
    if (url.includes('/v1/tasks?')) return Response.json({ data: [task], meta: { pagination: { nextCursor: null } } });
    throw new Error('Unexpected endpoint');
  }) as typeof fetch;
  return { request, travel, task, events, searches: () => searches };
}
test('serverless task completes once, then survives a new runner instance without replay', async () => {
  const store = new Store(':memory:'); const f = fixture();
  try {
    assert.equal((await new Sokosumi(config, store, f.travel, f.request).tick()).status, 'completed');
    assert.equal((await new Sokosumi(config, store, f.travel, f.request).tick()).status, 'idle');
    assert.equal(f.searches(), 1); assert.equal(f.events.length, 2);
  } finally { store.close(); }
});
test('uncertain completion reconciles the matching event instead of repeating search or completion', async () => {
  const store = new Store(':memory:'); const f = fixture(true);
  try {
    await assert.rejects(new Sokosumi(config, store, f.travel, f.request).tick(), /Connection lost/);
    assert.equal((await new Sokosumi(config, store, f.travel, f.request).tick()).status, 'completed');
    assert.equal(f.searches(), 1); assert.equal(f.events.length, 2);
  } finally { store.close(); }
});
test('invalid task input requests clarification without querying suppliers', async () => {
  const store = new Store(':memory:'); const f = fixture(false, true);
  try {
    assert.equal((await new Sokosumi(config, store, f.travel, f.request).tick()).status, 'input_required');
    assert.equal(f.task.status, 'INPUT_REQUIRED'); assert.equal(f.searches(), 0);
  } finally { store.close(); }
});

// A task the traveller can answer: the fixture records comments as user events with timestamps.
function conversation(description: string) {
  const f = fixture(false, false);
  f.task.description = description;
  const hotel = { id: 'h1', name: 'Test Hotel', stars: 3, rating: 9, cheapest_total: { amount: '80.00', currency: 'EUR' }, rooms: [{ offer_id: 'offer', board: 'Room only', refundable: true, total: { amount: '80.00', currency: 'EUR' } }] };
  f.travel.stays = (async () => ({ data: { hotels: [hotel] } })) as any;
  let clock = 0; const stamp = () => new Date(Date.UTC(2026, 9, 6, 12, 0, clock++)).toISOString();
  const post = f.request;
  const request = (async (url: string, options: RequestInit) => {
    const response = await post(url, options);
    if (url.includes(`/tasks/${id}/events`) && options.method !== 'GET') { const data = await response.clone().json(); data.data.createdAt = stamp(); f.events[f.events.length - 1].createdAt = data.data.createdAt; return Response.json(data); }
    return response;
  }) as typeof fetch;
  const userSays = (comment: string) => f.events.push({ id: `user-${f.events.length}`, taskId: id, status: f.task.status, comment, createdAt: stamp(), actor: { type: 'user', id: 'owner' } });
  return { ...f, request, userSays };
}
const asked = (e: any) => e.status === 'INPUT_REQUIRED' && e.actor?.id === coworker;

test('a reply on an INPUT_REQUIRED task continues the same task instead of staying blocked', async () => {
  const store = new Store(':memory:'); const f = conversation('Plan a trip to Cebu for 3 days');
  try {
    const run = () => new Sokosumi(config, store, f.travel, f.request).tick();
    assert.equal((await run()).status, 'input_required'); assert.equal(f.task.status, 'INPUT_REQUIRED');
    assert.match(f.events.find(asked).comment, /Which day/);
    assert.equal((await run()).status, 'idle');                          // nobody answered yet: nothing happens, nothing repeats
    assert.equal(f.events.filter(asked).length, 1);
    f.userSays('soon');                                                   // an unusable answer asks again, with what we already know kept
    assert.equal((await run()).status, 'input_required');
    assert.equal(f.events.filter(asked).length, 2);
    f.userSays('from 9 November');
    assert.equal((await run()).status, 'completed'); assert.equal(f.task.status, 'COMPLETED');
    assert.match(f.events.at(-1).comment, /Your 3-day trip to Cebu/); assert.match(f.events.at(-1).comment, /Mon 9 Nov/);
    assert.equal((await run()).status, 'idle');
  } finally { store.close(); }
});

test('an edited description set back to Ready resumes; an unchanged one does not loop', async () => {
  const store = new Store(':memory:'); const f = conversation('hmm'); const g = conversation('Plan a trip to Cebu'); const other = new Store(':memory:');
  try {
    assert.equal((await new Sokosumi(config, store, f.travel, f.request).tick()).status, 'completed');   // "hmm" is not a trip: it is redirected, not left waiting
    const go = () => new Sokosumi(config, other, g.travel, g.request).tick();
    assert.equal((await go()).status, 'input_required');
    g.task.status = 'READY';
    assert.equal((await go()).status, 'idle'); assert.equal(g.events.filter(asked).length, 1);   // same text, set to Ready: no loop
    g.task.description = 'Plan a trip to Cebu for 3 days from 9 November';
    assert.equal((await go()).status, 'completed');
  } finally { store.close(); other.close(); }
});

test('a task that was already waiting for input before we saw it is left alone', async () => {
  const store = new Store(':memory:'); const f = conversation('Plan a trip to Cebu from 9 November');
  try {
    f.task.status = 'INPUT_REQUIRED'; f.userSays('hello');
    assert.equal((await new Sokosumi(config, store, f.travel, f.request).tick()).status, 'idle');
    assert.equal(f.events.length, 1);
  } finally { store.close(); }
});

// Paid flow with a mocked payment node: no work before confirmed escrow, hash submitted once, collection tracked after completion.
test('paid task waits for confirmed escrow, submits the result hash once, then tracks collection', async () => {
  const paidConfig = getConfig({ FLIGHTS_ENABLED: 'true', SOKOSUMI_PAID: 'true', SOKOSUMI_COWORKER_ID: coworker, SOKOSUMI_COWORKER_API_KEY: 'coworker_test_runtime_secret', MASUMI_AGENT_IDENTIFIER: 'a'.repeat(64), MASUMI_TOKEN: 'mps_token' });
  const store = new Store(':memory:'); const f = conversation('Book the hotel under Anna Reyes');
  let bookings = 0; (f.travel as any).bookStay = async () => { bookings++; return { data: { id: 'BK1', confirmation_code: 'C1', total: { amount: '80.00', currency: 'EUR' } } }; };
  f.travel.stays = (async () => ({ data: { hotels: [{ id: 'h1', name: 'Test Hotel', stars: 3, rating: 9, cheapest_total: { amount: '80.00', currency: 'EUR' }, rooms: [{ offer_id: 'offer', board: 'Room only', refundable: true }] }] } })) as any;
  const stored = await buildPlan({ destination: (await import('../src/destinations.js')).findDestination('Cebu')[0]!.d, start: '2027-01-09', days: 3, travellers: 1 }, f.travel);
  await savePlan({ travel: f.travel, store, config: paidConfig }, 'owner', stored.plan);
  const calls: string[] = []; let submitted = ''; let onChain: any = { onChainState: null, CurrentTransaction: null, TransactionHistory: [] };
  const base = f.request;
  const confirmed = (state: string, extra: any = {}) => ({ ...extra, onChainState: state, CurrentTransaction: { status: 'Confirmed', newOnChainState: state, txHash: `tx-${state}` }, TransactionHistory: [{ status: 'Confirmed', newOnChainState: state, txHash: `tx-${state}` }] });
  const request = (async (url: string, options: RequestInit) => {
    if (!url.startsWith('http://127.0.0.1:3012')) return base(url, options);
    const path = url.replace('http://127.0.0.1:3012/api/v1', ''), body = JSON.parse(String(options.body));
    calls.push(path); assert.equal((options.headers as any).token, 'mps_token');
    if (path === '/payment') return Response.json({ status: 'success', data: { blockchainIdentifier: 'bid', agentIdentifier: 'a'.repeat(64), inputHash: body.inputHash, RequestedFunds: body.RequestedFunds, payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)), unlockTime: String(Date.parse(body.unlockTime)), externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)), sellerReturnAddress: null, SmartContractWallet: { walletVkey: 'vkey' }, PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'addr', policyId: 'policy' } } });
    if (path === '/payment/submit-result') { submitted = body.submitResultHash; return Response.json({ status: 'success', data: {} }); }
    return Response.json({ status: 'success', data: onChain });
  }) as typeof fetch;
  const tick = () => new Sokosumi(paidConfig, store, f.travel, request).tick();
  try {
    assert.equal((await tick()).status, 'idle');            // quoted, purchase event posted, escrow not funded: no search yet
    assert.equal(bookings, 0);
    assert.ok(f.events.some(e => e.masumiPayment?.blockchainIdentifier === 'bid'));
    assert.equal((await tick()).status, 'idle'); assert.equal(bookings, 0);
    onChain = confirmed('FundsLocked');                      // buyer's escrow confirmed
    assert.equal((await tick()).status, 'idle');             // searched and submitted the hash, waiting on-chain for it: no completion
    assert.equal(bookings, 1); assert.equal(calls.filter(c => c === '/payment/submit-result').length, 1);
    onChain = confirmed('ResultSubmitted', { resultHash: submitted });
    assert.equal((await tick()).status, 'completed');        // result confirmed on chain
    const done = f.events.find(e => e.status === 'COMPLETED');
    assert.match(done.comment, /preprod\.cexplorer\.io\/tx\/tx-FundsLocked/); assert.match(done.comment, /preprod\.cexplorer\.io\/tx\/tx-ResultSubmitted/);
    assert.equal(calls.filter(c => c === '/payment').length, 1); assert.equal(f.events.filter(e => e.masumiPayment).length, 1);
    onChain = confirmed('Withdrawn');
    assert.equal((await tick()).status, 'settled');
    assert.match(f.events.at(-1).comment, /preprod\.cexplorer\.io\/tx\/tx-Withdrawn/);
    assert.equal((await tick()).status, 'idle'); assert.equal(f.events.filter(e => /Payout collected/.test(e.comment ?? '')).length, 1);
    assert.equal(bookings, 1); assert.equal(calls.filter(c => c === '/payment/submit-result').length, 1);
  } finally { store.close(); }
});

// Planning is free; only the booking confirmation is charged.
test('a plan request is never charged, and a booking request with no plan to book is not charged either', async () => {
  const paidConfig = getConfig({ SOKOSUMI_PAID: 'true', SOKOSUMI_COWORKER_ID: coworker, SOKOSUMI_COWORKER_API_KEY: 'coworker_test_runtime_secret', MASUMI_AGENT_IDENTIFIER: 'a'.repeat(64), MASUMI_TOKEN: 'mps_token' });
  for (const text of ['Plan a trip to Cebu for 3 days from 9 November', 'Book the hotel']) {
    const store = new Store(':memory:'); const f = conversation(text);
    const request = (async (url: string, options: RequestInit) => { assert.ok(!url.startsWith('http://127.0.0.1:3012'), 'payment node must not be called'); return f.request(url, options); }) as typeof fetch;
    try {
      await new Sokosumi(paidConfig, store, f.travel, request).tick();
      assert.ok(!f.events.some(e => e.masumiPayment), text);
      assert.ok(f.events.some(e => e.status === 'COMPLETED' || e.status === 'INPUT_REQUIRED'), text);
    } finally { store.close(); }
  }
});

// AI agent mode: the model decides, code charges.
const agentUsage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } as any;
const agentCall = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call', toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'x' }, usage: agentUsage, warnings: [] }) as any;
const agentSay = (text: string) => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'x' }, usage: agentUsage, warnings: [] }) as any;
const agentModel = (...steps: any[]) => { let i = 0; return new MockLanguageModelV4({ doGenerate: async () => { const step = steps[Math.min(i++, steps.length - 1)]; if (step instanceof Error) throw step; return step; } }); };
const agentConfig = () => getConfig({ SOKOSUMI_PAID: 'true', OPENROUTER_API_KEY: 'sk-or-test', SOKOSUMI_COWORKER_ID: coworker, SOKOSUMI_COWORKER_API_KEY: 'coworker_test_runtime_secret', MASUMI_AGENT_IDENTIFIER: 'a'.repeat(64), MASUMI_TOKEN: 'mps_token' });
function agentFixture(text: string) {
  const f = conversation(text); const checkouts: string[] = [];
  const hotel = { id: 'h1', name: 'Test Hotel', cheapest_total: { amount: '80.00', currency: 'USD' }, rooms: [{ offer_id: 'h1', refundable: true }] };
  Object.assign(f.travel as any, { usesAdvisor: true, stays: async () => ({ data: { hotels: [hotel] } }), advisor: { checkout: async (i: any) => { checkouts.push(i.property_id); return { opened: true, trip_id: 'T1', checkout_url: 'https://pay.test/T1' }; } } });
  return { ...f, checkouts };
}
const noPaymentNode = (f: { request: typeof fetch }) => (async (url: string, options: RequestInit) => { assert.ok(!url.startsWith('http://127.0.0.1:3012'), 'payment node must not be called'); return f.request(url, options); }) as typeof fetch;
const stay = { city: 'Manila', country_code: 'PH', check_in: '2027-01-09', nights: 2, adults: 2 };

test('agent: a plan request is answered by the agent and never charged', async () => {
  const store = new Store(':memory:'); const f = agentFixture('Plan a trip to Manila from 9 January 2027, 2 people');
  try {
    const model = agentModel(agentCall('search_hotels', stay), agentCall('save_plan', { ...stay, hotel_id: 'h1' }), agentSay('# Manila plan\nStay at Test Hotel.'));
    assert.equal((await new Sokosumi(agentConfig(), store, f.travel, noPaymentNode(f), model).tick()).status, 'completed');
    assert.ok(!f.events.some(e => e.masumiPayment)); assert.match(f.events.at(-1).comment, /Manila plan/); assert.equal(f.checkouts.length, 0);
  } finally { store.close(); }
});

test('agent: a question from the agent becomes INPUT_REQUIRED and no payment is made', async () => {
  const store = new Store(':memory:'); const f = agentFixture('Plan a trip to Manila');
  try {
    const model = agentModel(agentCall('ask_user', { question: 'Which day would you like to arrive?' }));
    assert.equal((await new Sokosumi(agentConfig(), store, f.travel, noPaymentNode(f), model).tick()).status, 'input_required');
    assert.equal(f.events.at(-1).status, 'INPUT_REQUIRED'); assert.match(f.events.at(-1).comment, /Which day/); assert.ok(!f.events.some(e => e.masumiPayment));
  } finally { store.close(); }
});

test('agent: if the model fails the deterministic planner still answers, free', async () => {
  const store = new Store(':memory:'); const f = agentFixture('Plan a trip to Cebu for 3 days from 9 January 2027');
  const quiet = console.error; console.error = () => {};
  try {
    assert.equal((await new Sokosumi(agentConfig(), store, f.travel, noPaymentNode(f), agentModel(new Error('429 rate limited'))).tick()).status, 'completed');
    assert.ok(!f.events.some(e => e.masumiPayment)); assert.match(f.events.at(-1).comment, /Your 3-day trip to Cebu/);
  } finally { console.error = quiet; store.close(); }
});

test('agent: a confirmed booking opens the checkout first, charges once, and hands over the link only after escrow', async () => {
  const store = new Store(':memory:'); const f = agentFixture('Book the hotel'); const config = agentConfig();
  const stored = await buildPlan({ destination: { name: 'Manila', airport: '', city: 'Manila', country: 'PH', country_code: 'PH', aliases: [], activities: [] }, start: '2027-01-09', days: 3, travellers: 2 }, f.travel);
  await savePlan({ travel: f.travel, store, config }, 'owner', stored.plan);
  const calls: string[] = []; let submitted = ''; let onChain: any = { onChainState: null, CurrentTransaction: null, TransactionHistory: [] };
  const confirmed = (state: string, extra: any = {}) => ({ ...extra, onChainState: state, CurrentTransaction: { status: 'Confirmed', newOnChainState: state, txHash: `tx-${state}` }, TransactionHistory: [{ status: 'Confirmed', newOnChainState: state, txHash: `tx-${state}` }] });
  const base = f.request;
  const request = (async (url: string, options: RequestInit) => {
    if (!url.startsWith('http://127.0.0.1:3012')) return base(url, options);
    const path = url.replace('http://127.0.0.1:3012/api/v1', ''), body = JSON.parse(String(options.body)); calls.push(path);
    if (path === '/payment') return Response.json({ status: 'success', data: { blockchainIdentifier: 'bid', agentIdentifier: 'a'.repeat(64), inputHash: body.inputHash, RequestedFunds: body.RequestedFunds, payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)), unlockTime: String(Date.parse(body.unlockTime)), externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)), sellerReturnAddress: null, forceLayer: null, SmartContractWallet: { walletVkey: 'seller' }, PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'addr_sc', policyId: 'policy' } } });
    if (path === '/payment/submit-result') { submitted = body.submitResultHash; return Response.json({ status: 'success', data: {} }); }
    return Response.json({ status: 'success', data: onChain });
  }) as typeof fetch;
  const tick = () => new Sokosumi(config, store, f.travel, request, agentModel(agentCall('request_booking', {}), agentSay('unreachable'))).tick();
  try {
    assert.equal((await tick()).status, 'idle');                          // checkout opened, payment requested, escrow not funded
    assert.deepEqual(f.checkouts, ['h1']); assert.equal(f.events.filter(e => e.masumiPayment).length, 1);
    assert.ok(!f.events.some(e => /pay\.test/.test(e.comment ?? '')));    // no link yet
    onChain = confirmed('FundsLocked');
    assert.equal((await tick()).status, 'idle');                          // work done, result hash submitted
    onChain = confirmed('ResultSubmitted', { resultHash: submitted });
    assert.equal((await tick()).status, 'completed');
    assert.match(f.events.find(e => e.status === 'COMPLETED').comment, /https:\/\/pay\.test\/T1/);
    assert.equal(calls.filter(c => c === '/payment').length, 1); assert.deepEqual(f.checkouts, ['h1']);
  } finally { store.close(); }
});
