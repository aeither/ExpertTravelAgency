import { tripSearch } from './schemas.js';

export class TaskInputError extends Error {}

export function parseTravelTask(description: string) {
  const trimmed = description.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1]! : trimmed); }
  catch { throw new TaskInputError('Paste a JSON trip request with flights and/or stays. See the sample in the Coworker run instructions.'); }
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
  const lines = ['# Origin travel shortlist', '', `Observed: ${result.observed_at}`, ''];
  for (const [kind, part] of Object.entries(result.results) as [string, any][]) {
    lines.push(`${kind}: ${part.provider} / ${part.environment}`);
  }
  lines.push('', 'Sandbox and demo results are test inventory. Refresh the selected offer before any booking.');
  const flight = result.summary.flights;
  if (flight) {
    lines.push('', `Compared ${flight.offers_found} flight offers.`);
    for (const label of ['cheapest', 'fastest']) {
      const option = flight[label];
      if (option) lines.push(`- ${label}: ${option.airline}, ${option.route}, ${option.total.amount} ${option.total.currency}, ${option.duration_minutes ?? 'unknown'} minutes, ${option.stops} stops. Departs ${option.departs_at}. Offer: ${option.offer_id}.`);
    }
  }
  const hotels = result.summary.hotels;
  if (hotels) {
    lines.push('', `Compared ${hotels.hotels_found} hotels.`);
    if (hotels.cheapest) lines.push(`- Cheapest: ${hotels.cheapest.name}, ${hotels.cheapest.total.amount} ${hotels.cheapest.total.currency}.`);
    for (const hotel of hotels.top_rated ?? []) lines.push(`- ${hotel.name}: rating ${hotel.rating ?? 'unknown'}, ${hotel.total.amount} ${hotel.total.currency}, refundable: ${hotel.refundable}.`);
  }
  if (result.summary.estimated_total) lines.push('', `Combined estimate: ${JSON.stringify(result.summary.estimated_total)}`);
  lines.push('', 'Prices are compared within the supplier response; no currency conversion is applied. This task performs search only.', '', `API documentation: ${baseUrl.replace(/\/$/, '')}/docs`, '', 'Exact search summary:', '```json', JSON.stringify(result.summary, null, 2), '```');
  return { input, result, answer: lines.join('\n') + '\n' };
}
