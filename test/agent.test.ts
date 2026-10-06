import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { runAgent, instructions } from '../src/agent.js';
import { loadPlan } from '../src/planner.js';
import { Store } from '../src/store.js';
import { getConfig } from '../src/config.js';
import type { Travel } from '../src/travel.js';

const today = new Date('2026-10-07T00:00:00Z');
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } as any;
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call', toolCallId: `c-${Math.random()}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }) as any;
const say = (text: string) => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) as any;
const script = (...steps: any[]) => { let i = 0; return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)] }); };

function fixture(checkout: (id: string) => any = () => ({ opened: true, trip_id: 'T1', checkout_url: 'https://pay.test/T1' })) {
  const hotels = [{ id: 'h1', name: 'First Hotel', cheapest_total: { amount: '80.00', currency: 'USD' }, rooms: [{ offer_id: 'h1', refundable: true }] }, { id: 'h2', name: 'Second Hotel', cheapest_total: { amount: '90.00', currency: 'USD' }, rooms: [{ offer_id: 'h2', refundable: true }] }];
  const opened: string[] = [];
  const travel = { usesAdvisor: true, stays: async () => ({ data: { hotels } }), advisor: { checkout: async (i: any) => { opened.push(i.property_id); return checkout(i.property_id); } } } as unknown as Travel;
  const store = new Store(':memory:');
  return { store, opened, deps: { travel, store, config: getConfig({ SOKOSUMI_PAID: 'true' }) } };
}
const trip = { city: 'Manila', country_code: 'PH', check_in: '2026-10-18', nights: 2, adults: 2 };

test('the agent searches, saves a plan and answers; planning opens no checkout', async () => {
  const f = fixture();
  try {
    const model = script(call('search_hotels', trip), call('save_plan', { ...trip, hotel_id: 'h1' }), say('# Your trip to Manila\nStay at First Hotel.'));
    const d = await runAgent('Plan a trip to Manila from 18 October, 2 people', f.deps, 'u1', { model, today });
    assert.equal(d.kind, 'answer'); assert.match(d.text, /First Hotel/);
    const saved = (await loadPlan(f.deps, 'u1')).plan!;
    assert.equal(saved.hotel.id, 'h1'); assert.equal(saved.request.travellers, 2); assert.equal(saved.end, '2026-10-20'); assert.equal(f.opened.length, 0);
    assert.match(model.doGenerateCalls[0]!.prompt.map((m: any) => JSON.stringify(m)).join(''), /Plan a trip to Manila/);
  } finally { f.store.close(); }
});

test('a missing detail becomes a question and ends the turn', async () => {
  const f = fixture();
  try {
    const d = await runAgent('Plan a trip to Manila', f.deps, 'u1', { model: script(call('ask_user', { question: 'Which day would you like to arrive?' }), say('should never be reached')), today });
    assert.deepEqual(d, { kind: 'ask', text: 'Which day would you like to arrive?' });
  } finally { f.store.close(); }
});

test('booking: the checkout opens before any charge, falls back to the next hotel, and the agent never sees the link', async () => {
  const f = fixture(id => id === 'h1' ? { opened: false, failure_reason: 'no offer' } : { opened: true, trip_id: 'T2', checkout_url: 'https://pay.test/T2' });
  try {
    await runAgent('plan', f.deps, 'u1', { model: script(call('search_hotels', trip), call('save_plan', { ...trip, hotel_id: 'h1' }), say('plan')), today });
    const model = script(call('request_booking', {}), say('should never be reached'));
    const d = await runAgent('Book the hotel', f.deps, 'u1', { model, today });
    assert.equal(d.kind, 'book'); assert.deepEqual(f.opened, ['h1', 'h2']);
    const plan = (await loadPlan(f.deps, 'u1')).plan!;
    assert.equal(plan.hotel.id, 'h2'); assert.equal(plan.checkout!.url, 'https://pay.test/T2');
    assert.doesNotMatch(JSON.stringify(model.doGenerateCalls), /pay\.test/);
  } finally { f.store.close(); }
});

test('no plan, or no checkout that opens: the booking is refused and the agent explains, so nothing is charged', async () => {
  const f = fixture(() => ({ opened: false, failure_reason: 'no offer' }));
  try {
    const none = await runAgent('Book the hotel', f.deps, 'u1', { model: script(call('request_booking', {}), say('Please ask me for a plan first.')), today });
    assert.equal(none.kind, 'answer');
    await runAgent('plan', f.deps, 'u1', { model: script(call('search_hotels', trip), call('save_plan', { ...trip, hotel_id: 'h1' }), say('plan')), today });
    const failed = await runAgent('Book the hotel', f.deps, 'u1', { model: script(call('request_booking', {}), say('I could not open a checkout. Nothing was charged.')), today });
    assert.equal(failed.kind, 'answer'); assert.match(failed.text, /Nothing was charged/);
  } finally { f.store.close(); }
});

test('past dates and made-up hotel ids are rejected by the tools, not trusted from the model', async () => {
  const f = fixture();
  try {
    const model = script(call('search_hotels', { ...trip, check_in: '2026-10-01' }), call('save_plan', { ...trip, hotel_id: 'nope' }), say('Sorry, that date has passed.'));
    const d = await runAgent('x', f.deps, 'u1', { model, today });
    assert.equal(d.kind, 'answer'); assert.equal((await loadPlan(f.deps, 'u1')).plan, undefined);
  } finally { f.store.close(); }
});

test('the system prompt states the fee and the saved plan, and tells the model plans are free', () => {
  const text = instructions('2026-10-07', '1 test USDM', undefined);
  assert.match(text, /1 test USDM/); assert.match(text, /No plan is saved/); assert.match(text, /Plans are free/); assert.match(text, /Never answer a plan request by repeating the saved plan/);
});

test('a question written as plain text is still treated as a question', async () => {
  const f = fixture();
  try {
    const d = await runAgent('Plan a trip to Manila', f.deps, 'u1', { model: script(say('When are you arriving?')), today });
    assert.deepEqual(d, { kind: 'ask', text: 'When are you arriving?' });
  } finally { f.store.close(); }
});
