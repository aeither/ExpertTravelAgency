import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const config = getConfig();
if (config.TRAVEL_MODE !== 'live') throw new Error('Use TRAVEL_MODE=live. This check must call suppliers.');
const { app } = await buildApp(config, { poll: false });
const headers = config.API_KEY ? { authorization: `Bearer ${config.API_KEY}` } : {};
const date = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const report: Record<string, unknown> = { checked_at: new Date().toISOString() };
async function call(url: string, payload?: unknown, extra: Record<string, string> = {}) {
  const response = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { payload: payload as any }) });
  const data = response.json();
  if (response.statusCode !== 200) throw new Error(`${url}: HTTP ${response.statusCode} ${data.error?.code} ${JSON.stringify(data.error?.details ?? {})}`);
  return data;
}
try {
  if (config.DUFFEL_ACCESS_TOKEN) {
    const flights = await call('/v1/flights/search', { slices: [{ origin: 'SIN', destination: 'BKK', departure_date: date(30) }], passengers: [{ type: 'adult' }], cabin_class: 'economy', max_connections: 0 });
    const offers = flights.data.offers;
    if (!Array.isArray(offers) || !offers.length) throw new Error('No flight offers returned.');
    report.flight_search = { environment: flights.environment, offers: offers.length };
    const chosen = offers.find((o: any) => o.owner?.iata_code === 'ZZ') ?? offers[0];
    const refreshed = await call(`/v1/flights/offers/${chosen.id}`);
    report.flight_reprice = { environment: refreshed.environment, currency: refreshed.data.total_currency };
    if (process.argv.includes('--book-test')) {
      if (!config.DUFFEL_ACCESS_TOKEN.startsWith('duffel_test_') || refreshed.data.live_mode !== false) throw new Error('This script only books Duffel test offers.');
      const input = { offer_id: chosen.id, passengers: refreshed.data.passengers.map((p: any) => ({ id: p.id, given_name: 'Test', family_name: 'Traveler', born_on: '1990-01-01', gender: 'm', title: 'mr', email: 'test@example.com', phone_number: '+6591234567' })), max_total: { amount: refreshed.data.total_amount, currency: refreshed.data.total_currency }, confirm: true };
      const key = `verify-${randomUUID()}`;
      const booked = await call('/v1/flights/bookings', input, { 'idempotency-key': key });
      const replay = await call('/v1/flights/bookings', input, { 'idempotency-key': key });
      if (booked.data.live_mode !== false || !replay.replayed || booked.data.id !== replay.data.id) throw new Error('Test booking or replay validation failed.');
      const status = await call(`/v1/bookings/flight/${booked.data.id}`);
      report.flight_test_booking = { order_id: booked.data.id, live_mode: status.data.live_mode, replay_verified: true };
    }
  } else report.flight_search = { status: 'credentials_missing' };
  if (config.LITEAPI_API_KEY) {
    const stays = await call('/v1/stays/search', { check_in_date: date(35), check_out_date: date(37), rooms: [{ adults: 2 }], location: { city: 'Singapore', country_code: 'SG' }, limit: 5 });
    const hotels = stays.data.hotels;
    if (!Array.isArray(hotels) || !hotels.length || !hotels[0].rooms.length) throw new Error('LiteAPI did not return hotels with room rates.');
    report.hotel_search = { environment: stays.environment, hotels: hotels.length, cheapest: hotels[0].cheapest_total };
  } else report.hotel_search = { status: 'credentials_missing' };
} finally {
  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await app.close();
}
