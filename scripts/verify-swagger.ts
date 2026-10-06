// Execute the exact examples served to Swagger against a deployed API.
// No mocks, demo responses, bookings, or payment operations.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = (process.env.BASE_URL ?? 'https://origin-travel-agent.vercel.app').replace(/\/$/, '');
const get = async (path: string) => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response.json();
};
const spec = await get('/openapi.json');
const uiSpec = await get('/docs/json');
const report: any = { base, verified_at: new Date().toISOString(), results: [] };
const usefulStays = (result: any) => {
  assert.equal(result.provider, 'liteapi');
  assert.ok(['sandbox', 'production'].includes(result.environment));
  assert.ok(result.data.hotels.length > 0, 'No hotels returned');
  for (const hotel of result.data.hotels) {
    assert.ok(hotel.name && hotel.address, 'Hotel identity/address missing');
    assert.ok(hotel.rooms.some((room: any) => room.rate_id && Number(room.total?.amount) > 0 && room.total.currency === 'USD'), 'No usable priced room');
  }
};
const usefulFlights = (result: any) => {
  assert.equal(result.provider, 'duffel');
  assert.ok(['sandbox', 'production'].includes(result.environment));
  assert.ok(result.data.offers.some((offer: any) => offer.id && Number(offer.total_amount) > 0 && offer.slices?.length), 'No usable priced flight');
};
await mkdir('docs/verification', { recursive: true });
for (const path of ['/v1/stays/search', '/v1/flights/search', '/v1/trips/search']) {
  const example = spec.paths[path].post.requestBody.content['application/json'].example;
  assert.ok(example, `${path}: missing example`);
  assert.deepEqual(uiSpec.paths[path].post.requestBody.content['application/json'].example, example);
  const start = Date.now();
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(example), signal: AbortSignal.timeout(90000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
  if (path.includes('/stays/')) usefulStays(body);
  else if (path.includes('/flights/')) usefulFlights(body);
  else { assert.equal(body.complete, true); usefulStays(body.results.stays); usefulFlights(body.results.flights); assert.ok(body.summary.flights.cheapest && body.summary.hotels.cheapest); }
  const result = { path, request: example, status: response.status, duration_ms: Date.now() - start, response: body };
  report.results.push(result);
  await writeFile('docs/verification/swagger-live.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ path, status: response.status, duration_ms: result.duration_ms, provider: body.provider ?? 'duffel + liteapi', environment: body.environment, hotels: body.data?.hotels?.length ?? body.results?.stays?.data?.hotels?.length, offers: body.data?.offers?.length ?? body.results?.flights?.data?.offers?.length }));
}
console.log('Verified deployed Swagger examples; full requests/responses saved to docs/verification/swagger-live.json');
