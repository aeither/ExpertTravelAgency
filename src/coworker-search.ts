import { tripSearch } from './schemas.js';

export class TaskInputError extends Error {}

export function parseTravelTask(description: string) {
  const trimmed = description.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1]! : trimmed); }
  catch { throw new TaskInputError('That looks like JSON, but I could not read it. Fix the JSON, or just describe your trip in words, for example: "Plan a trip to Cebu for 3 days from 9 November". Reply on this task, or create a new task, with the fix.'); }
  const parsed = tripSearch.safeParse(value);
  if (!parsed.success) throw new TaskInputError(parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('\n'));
  return parsed.data;
}

export async function runTravelTask(description: string, baseUrl: string, request: typeof fetch = fetch) {
  const input = parseTravelTask(description);
  const response = await request(`${baseUrl.replace(/\/$/, '')}/v1/trips/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`Travel search HTTP ${response.status}`);
  const result: any = await response.json();
  if (!result.complete || !result.results || !result.summary) throw new Error('Supplier search was incomplete; no successful shortlist can be delivered.');
  const money = (t: any) => `${t.amount} ${t.currency}`;
  const duration = (m: unknown) => typeof m === 'number' ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : 'unknown length';
  const when = (iso: string) => Number.isNaN(Date.parse(iso + 'Z')) ? iso : new Date(iso + 'Z').toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const stops = (n: number) => n === 0 ? 'direct' : n === 1 ? '1 stop' : `${n} stops`;
  const lines = ['# Your trip options', ''];
  const flight = result.summary.flights;
  const hotels = result.summary.hotels;
  if (flight) {
    lines.push('## Flights', '');
    const { cheapest, fastest } = flight;
    if (cheapest) lines.push(`- **Cheapest:** ${cheapest.airline}, ${cheapest.route}, ${money(cheapest.total)}. ${stops(cheapest.stops)}, ${duration(cheapest.duration_minutes)}. Leaves ${when(cheapest.departs_at)}.`);
    if (fastest && fastest.offer_id !== cheapest?.offer_id) lines.push(`- **Fastest:** ${fastest.airline}, ${fastest.route}, ${money(fastest.total)}. ${stops(fastest.stops)}, ${duration(fastest.duration_minutes)}. Leaves ${when(fastest.departs_at)}.`);
    lines.push('');
  }
  if (hotels) {
    lines.push('## Hotels', '');
    if (hotels.cheapest) lines.push(`- **Cheapest:** ${hotels.cheapest.name}, ${money(hotels.cheapest.total)}.`);
    for (const hotel of hotels.top_rated ?? []) lines.push(`- **Best rated:** ${hotel.name}, ${hotel.rating ?? 'no'}/10, ${money(hotel.total)}. ${hotel.refundable ? 'Free cancellation.' : 'Not refundable.'}`);
    lines.push('');
  }
  const total = result.summary.estimated_total;
  if (total?.amount) lines.push(`**Rough total (cheapest flight + cheapest hotel): ${money(total)}**`, '');
  else if (total) lines.push('**Rough total:** the flight and hotel prices are in different currencies, so we did not add them up (no currency conversion).', '');
  lines.push('_These are practice prices for testing, not real bookings. Nothing has been booked or paid. Ask us to book your favourite and we will check the price again first._', '', '<details><summary>Booking codes</summary>', '');
  if (flight?.cheapest) lines.push(`Cheapest flight: ${flight.cheapest.offer_id}`);
  if (flight?.fastest) lines.push(`Fastest flight: ${flight.fastest.offer_id}`);
  lines.push('', '</details>', '');
  return { input, result, answer: lines.join('\n') + '\n' };
}
