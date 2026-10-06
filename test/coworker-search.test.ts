import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTravelTask, runTravelTask, TaskInputError } from '../src/coworker-search.js';

const description = JSON.stringify({ flights: { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: '2099-11-10' }], passengers: [{ type: 'adult' }] } });
test('task input accepts JSON fences and rejects missing dates and booking requests', () => {
  assert.equal(parseTravelTask('```json\n' + description + '\n```').flights?.slices[0]?.origin, 'SIN');
  for (const invalid of ['Find cheap flights', '{}', '{"flights":{"confirm":true}}']) assert.throws(() => parseTravelTask(invalid), TaskInputError);
});
test('failed or partial upstream search cannot produce a successful task answer', async () => {
  await assert.rejects(runTravelTask(description, 'https://example.test', (async () => new Response('{}', { status: 503 })) as typeof fetch), /HTTP 503/);
  await assert.rejects(runTravelTask(description, 'https://example.test', (async () => Response.json({ complete: false, summary: {} })) as typeof fetch), /incomplete/);
});
test('shortlist preserves supplier prices, environment, identifiers, and currency limits', async () => {
  const fixture = { complete: true, observed_at: '2026-10-06T12:00:00Z', results: { flights: { provider: 'duffel', environment: 'sandbox' } }, summary: { flights: { offers_found: 2, cheapest: { airline: 'Test Air', route: 'SIN→BKK', total: { amount: '79.76', currency: 'EUR' }, duration_minutes: 148, stops: 0, departs_at: '2099-11-10', offer_id: 'off_123' } } } };
  const output = await runTravelTask(description, 'https://example.test', (async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://example.test/v1/trips/search');
    assert.equal(JSON.parse(String(options.body)).flights.slices[0].origin, 'SIN');
    return Response.json(fixture);
  }) as typeof fetch);
  assert.match(output.answer, /79.76 EUR/);
  assert.match(output.answer, /Cheapest/);
  assert.doesNotMatch(output.answer, /sandbox|JSON|\{/);
  assert.match(output.answer, /off_123/);
  assert.match(output.answer, /Nothing has been booked/);
  assert.deepEqual(output.result, fixture);
});
