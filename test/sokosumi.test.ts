import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sokosumi } from '../src/sokosumi.js';
import { Store } from '../src/store.js';
import { getConfig } from '../src/config.js';
import type { Travel } from '../src/travel.js';

const coworker = '01a11100-48ed-74a7-b050-f616bc9751d6';
const id = '01a11103-ed45-7068-b0c6-2ffc923a8fd7';
const config = getConfig({ SOKOSUMI_COWORKER_ID: coworker, SOKOSUMI_COWORKER_API_KEY: 'coworker_test_runtime_secret' });
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
      events.push(event); task.status = body.status;
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
