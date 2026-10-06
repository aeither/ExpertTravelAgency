import type { Config } from './config.js';
import type { Storage } from './store.js';
import type { Travel } from './travel.js';
import { ApiError } from './errors.js';
import { journaledBooking } from './journal.js';
import { TaskInputError, runTravelTask } from './coworker-search.js';
import { destinations, findDestination, type Destination } from './destinations.js';
import type { StayBooking } from './schemas.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const day = (iso: string) => new Date(iso + 'T00:00:00Z');
const addDays = (iso: string, n: number) => new Date(day(iso).getTime() + n * 86400000).toISOString().slice(0, 10);
const prettyDate = (iso: string) => day(iso.slice(0, 10)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const money = (m: { amount: string; currency: string }) => `${Number(m.amount).toFixed(2)} ${m.currency}`;

export interface TripRequest { destination: Destination; start: string; days: number; travellers: number; notes?: string[] }
export type Intent =
  | { kind: 'plan'; request: TripRequest }
  | { kind: 'book'; hotel: boolean; flight: boolean; guest?: { given_name: string; family_name: string; email?: string } }
  | { kind: 'redirect'; message: string };

export const MAX_TRAVELLERS = 4;
const MAX_DAYS_AHEAD = 330;
const MAX_TEXT = 2000;
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const asNumber = (s: string) => /^\d+$/.test(s) ? Number(s) : WORD_NUMBERS[s];
const MONTH_RE = MONTHS.join('|');
const placeNames = () => destinations.map(d => d.name).join(', ');
// Every refusal names what this coworker can do and shows a request that works.
const exampleRequest = (today: Date) => { const d = new Date(today.getTime() + 35 * 86400000); return `Plan a trip to Cebu for 3 days from ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.replace(/^./, c => c.toUpperCase())}`; };
const capabilities = (today: Date) => `I plan activities and recommend the best hotels for trips to ${placeNames()}, and I can book a hotel once you like the plan. I do not search or book flights, and I cannot change or cancel bookings, or give visa, weather or insurance advice. Try: "${exampleRequest(today)}".`;
const ASK_AGAIN = ' Reply on this task, or create a new task, with the missing detail.';

// Pull a start date out of a sentence. Returns undefined when there is none; throws when the date cannot be used.
function findStart(lower: string, today: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayIso = today.toISOString().slice(0, 10);
  const tomorrow = addDays(todayIso, 1);
  const span = '(?:\\s*(?:-|–|to|until|till)\\s*(\\d{1,2})(?:st|nd|rd|th)?)?';
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?${span}\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s+(20\\d\\d))?`).exec(lower);
  const md = !dm && new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?${span}\\b(?:,?\\s+(20\\d\\d))?`).exec(lower);
  const hit = dm ? { month: dm[3]!, dom: Number(dm[1]), end: dm[2], year: dm[4] } : md ? { month: md[1]!, dom: Number(md[2]), end: md[3], year: md[4] } : undefined;
  const iso8601 = /\b(20\d\d)-(\d{2})-(\d{2})\b/.exec(lower);
  let iso: string | undefined, rolled = false, range: number | undefined;
  if (hit) {
    const month = MONTHS.indexOf(hit.month);
    let year = hit.year ? Number(hit.year) : today.getUTCFullYear();
    iso = `${year}-${pad(month + 1)}-${pad(hit.dom)}`;
    if (!hit.year && iso < tomorrow && new Date(iso + 'T00:00:00Z').getUTCDate() === hit.dom) { year += 1; iso = `${year}-${pad(month + 1)}-${pad(hit.dom)}`; rolled = true; }
    if (hit.end && Number(hit.end) > hit.dom) range = Number(hit.end) - hit.dom + 1;
  } else if (iso8601) iso = iso8601[0];
  else if (/\btomorrow\b/.test(lower)) iso = tomorrow;
  else if (/\b(today|tonight)\b/.test(lower)) throw new TaskInputError(`Hotels need at least a day's notice. Which day from ${prettyDate(tomorrow)} onwards would you like to arrive?`);
  else if (/\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/.test(lower)) throw new TaskInputError('Please write the date with the month name, for example "9 November", so I do not mix up the day and the month.');
  if (!iso) return undefined;
  if (Number.isNaN(Date.parse(iso)) || new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) !== iso) throw new TaskInputError('That date does not exist. Please check the day and month.');
  if (iso < tomorrow) throw new TaskInputError(`${prettyDate(iso)} ${iso.slice(0, 4)} has already passed. Which day from ${prettyDate(tomorrow)} onwards would you like to arrive?`);
  if (rolled && iso > addDays(todayIso, MAX_DAYS_AHEAD)) throw new TaskInputError(`${prettyDate(tomorrow)} is the earliest day I can use, and the date you gave has already passed this year. Which day from ${prettyDate(tomorrow)} onwards would you like to arrive?`);
  if (iso > addDays(todayIso, MAX_DAYS_AHEAD)) throw new TaskInputError('Hotels only open bookings about 11 months ahead. Please pick a closer date.');
  return { iso, rolled, range };
}

function findLength(lower: string) {
  const m = new RegExp(`\\b(\\d{1,3}|${NUMBER_WORDS})[\\s-]*(days?|nights?)\\b`).exec(lower);
  if (m) { const n = asNumber(m[1]!)!; return m[2]!.startsWith('night') ? n + 1 : n; }
  if (/\b(two|2)\s+weeks?\b/.test(lower)) return 14;
  if (/\bfor\s+(a|one|1)\s+week\b|\b(a|one|1)[\s-]week\b/.test(lower)) return 7;
  if (/\bweekend\b/.test(lower)) return 3;
}

function findTravellers(lower: string) {
  const m = new RegExp(`\\b(\\d{1,3}|${NUMBER_WORDS})\\s+(?:people|persons|adults|travell?ers|passengers|pax|guests)\\b`).exec(lower)
    ?? new RegExp(`\\b(?:family|group|party)\\s+of\\s+(\\d{1,3}|${NUMBER_WORDS})\\b`).exec(lower)
    ?? new RegExp(`\\b(\\d{1,3}|${NUMBER_WORDS})\\s+of\\s+us\\b`).exec(lower);
  if (m) return asNumber(m[1]!)!;
  return /\b(couple|wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?|honeymoon)\b|\bme and my\b/.test(lower) ? 2 : 1;
}

export function parseMessage(text: string, today = new Date()): Intent {
  const trimmed = text.trim();
  if (!trimmed) throw new TaskInputError(`The task is empty. Tell me where and when you want to travel. ${capabilities(today)}`);
  if (trimmed.length > MAX_TEXT) throw new TaskInputError(`That is a lot of text for me. Please shorten it to one or two sentences, for example "${exampleRequest(today)}".`);
  const lower = trimmed.toLowerCase();
  const places = findDestination(trimmed);
  const start = (() => { try { return findStart(lower, today); } catch (e) { return e as TaskInputError; } })();
  const complete = places.length > 0 && !!start && !(start instanceof Error);

  // Requests this coworker cannot serve get a clear answer and a way forward, not a dead end.
  if (/\b(cancel|refund|reschedule|amend|modify)\b|\bchange (?:my|the|our)\s+(?:booking|reservation|flight|hotel|dates?)\b/.test(lower) && !/\b(plan|find|search)\b/.test(lower))
    return { kind: 'redirect', message: `# I cannot change or cancel a booking\n\nI can only plan trips and make new hotel bookings. To cancel or change one, contact the hotel with your booking number and confirmation code from my booking message. If you would rather start over, ask me for a new plan.\n\n${capabilities(today)}\n` };
  if (/^(hi|hello|hey|hallo|hola|help|start|test|thanks|thank you|ok|okay)\W*$/.test(lower) || /\b(what can you do|who are you|how does (?:this|it) work|what do you do)\b/.test(lower))
    return { kind: 'redirect', message: `# Hello, I am your travel expert\n\n${capabilities(today)}\n` };
  if (/\b(weather|forecast|visa|passport|vaccin\w*|insurance|exchange rate|currency|sim card|esim|car rental|rent a car|restaurants?|stocks?|crypto|code)\b/.test(lower) && !/\b(plan|book|reserve|itinerary)\b/.test(lower) && !complete)
    return { kind: 'redirect', message: `# That is outside what I can help with\n\nI cannot give weather, visa, insurance or other advice, and I cannot answer general questions. ${capabilities(today)}\n` };

  const wantsBook = /\b(book|reserve)\b/.test(lower) && !/\b(plan|itinerary)\b/.test(lower);
  if (wantsBook && !complete) {
    const name = /\b(?:under(?:\s+the\s+name)?|for|name(?:\s+is)?|guest)\s*:?\s+([A-Z][a-z'’-]+)\s+([A-Z][a-z'’-]+)/.exec(trimmed);
    const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(trimmed)?.[0];
    const flight = /\bflights?\b/.test(lower);
    return { kind: 'book', flight, hotel: /\b(hotels?|room|stay|accommodation)\b/.test(lower) || !flight, guest: name ? { given_name: name[1]!, family_name: name[2]!, ...(email ? { email } : {}) } : undefined };
  }

  if (!places.length) {
    // A place we do not cover is said out loud, instead of asking again where they want to go.
    const unknown = /\b(?:trip|travel|fly|go|going|visit|holiday|vacation|flights?|getaway)\s+to\s+(?:the\s+)?([a-z][a-z'-]{2,})/.exec(lower) ?? /\bto\s+([a-z][a-z'-]{3,})\s+(?:for|from|on|in)\b/.exec(lower);
    const filler = new Set(['book', 'plan', 'stay', 'visit', 'travel', 'see', 'fly', 'the', 'somewhere', 'anywhere', 'relax', 'explore', 'leave', 'with', 'next', 'this', 'there']);
    if (unknown && !filler.has(unknown[1]!)) throw new TaskInputError(`I cannot plan trips to ${unknown[1]!.replace(/^./, c => c.toUpperCase())} yet. I can plan trips to ${placeNames()}. Would you like one of those instead?${ASK_AGAIN}`);
    if (!/\b(plan|trip|holiday|vacation|getaway|visit|travel|fly|flights?|hotels?|stay|itinerary)\b/.test(lower) && !start) return { kind: 'redirect', message: `# I am not sure what you need\n\n${capabilities(today)}\n` };
    throw new TaskInputError(`Where would you like to go? I can plan trips to ${placeNames()}. For example: "${exampleRequest(today)}".${ASK_AGAIN}`);
  }

  // Flights are off, so there is no starting point: the trip is about where you stay and what you do.
  const distinct = [...new Map(places.map(p => [p.d.name, p.d])).values()];
  const pair = /(\w+) to (\w+)/.exec(lower);
  const pairEnd = pair && findDestination(pair[1]!)[0] && findDestination(pair[2]!)[0] ? findDestination(pair[2]!)[0]!.d : undefined;
  if (distinct.length > 1 && !pairEnd) throw new TaskInputError(`I plan one destination at a time, and you mentioned ${distinct.map(d => d.name).join(' and ')}. Which one would you like me to plan first?${ASK_AGAIN}`);
  const destination = pairEnd ?? distinct[0]!;

  if (start instanceof Error) throw start;
  if (!start) throw new TaskInputError(`Which day would you like to arrive in ${destination.name}? For example: "from 9 November".${ASK_AGAIN}`);
  const notes: string[] = [];
  if (start.rolled) notes.push(`I read your date as ${prettyDate(start.iso)} ${start.iso.slice(0, 4)}, because that day has already passed this year.`);

  const named = findLength(lower);
  const days = named ?? start.range ?? 3;
  if (named === undefined && !start.range) notes.push('You did not say how long you want to stay, so I planned 3 days.');
  if (days < 2 || days > 14) throw new TaskInputError(`I can plan trips of 2 to 14 days, and ${days} is outside that. How long would you like to stay?${ASK_AGAIN}`);

  if (/\b(kids?|child(?:ren)?|babies|baby|infants?|toddlers?|teens?|teenagers?|son|daughter)\b/.test(lower)) throw new TaskInputError(`I can only plan for adults at the moment, because prices for children depend on their ages. How many adults are travelling? For example: "${destination.name} for ${days} days from ${prettyDate(start.iso).replace(/^\w+, /, '')}, 2 adults".${ASK_AGAIN}`);
  const travellers = findTravellers(lower);
  if (!Number.isInteger(travellers) || travellers < 1) throw new TaskInputError(`How many people are travelling? I can plan for 1 to ${MAX_TRAVELLERS}.${ASK_AGAIN}`);
  if (travellers > MAX_TRAVELLERS) throw new TaskInputError(`I can plan for up to ${MAX_TRAVELLERS} travellers in one room. For ${travellers}, please send separate requests of ${MAX_TRAVELLERS} or fewer.${ASK_AGAIN}`);

  // Preferences this version cannot apply are said out loud, so nobody assumes they were honoured.
  if (/\bflights?\b|\b(business|first)\s+class\b|\bpremium economy\b|\bairlines?\b/.test(lower)) notes.push('I do not search flights for now, so this plan covers activities and hotels only.');
  if (/\b(under|below|less than|max(?:imum)?|budget(?: of)?|cheaper than)\s*(?:[$€£]|usd|eur)?\s*\d+|[$€£]\s*\d+/.test(lower)) notes.push('I cannot filter by budget yet, so I chose good value. Compare the hotel prices below with your budget.');
  if (/\b(visa|passport|insurance|vaccin\w*)\b/.test(lower)) notes.push('I cannot check visa, passport, insurance or health rules. Please check them with the official sources for your nationality.');
  if (/\b(\d[\s-]*stars?|luxury|resort|beach ?front|pool)\b/.test(lower)) notes.push('I cannot filter hotels by stars or facilities yet. I recommend the best rated hotels for their price.');
  if (/\b(book|reserve)\b/.test(lower)) notes.push('I plan first and book second. Read the plan below, then say "book the hotel" and I will reserve my top pick.');
  return { kind: 'plan', request: { destination, start: start.iso, days, travellers, ...(notes.length ? { notes } : {}) } };
}

// Hotels worth recommending: well reviewed, and cheap for what you get.
const value = (h: any, nights: number) => {
  const price = Number(h.cheapest_total?.amount) / nights;
  return (Number(h.rating) || 0) / Math.log(price + 10) + (h.rooms?.[0]?.refundable ? 0.1 : 0);
};

export interface Plan {
  id: string; request: TripRequest; end: string; currency: string; attempt: number;
  hotel: { id: string; name: string; rating: number | null; stars: number | null; total: { amount: string; currency: string }; refundable: boolean; board: string | null; nights: number; offer_id: string };
  alternatives: { name: string; rating: number | null; total: { amount: string; currency: string } }[];
  booked?: { booking_id: string; confirmation_code: string | null; guest: string; total: { amount: string; currency: string }; operation_id: string };
}

export async function buildPlan(request: TripRequest, travel: Travel): Promise<{ plan: Plan; answer: string }> {
  const { destination, start, days, travellers } = request;
  const end = addDays(start, days - 1), nights = days - 1;
  const currency = 'USD';
  const found: any = await travel.stays({ check_in_date: start, check_out_date: end, rooms: [{ adults: travellers }], location: { city: destination.city, country_code: destination.country_code }, currency, guest_nationality: 'US', limit: 20 });
  const hotels: any[] = (found.data.hotels ?? []).filter((h: any) => h.cheapest_total && h.rooms?.[0]?.offer_id && Number(h.cheapest_total.amount) > 0);
  if (!hotels.length) throw new TaskInputError(`I could not find an available hotel in ${destination.name} for ${prettyDate(start)} to ${prettyDate(end)}. Please try other dates.${ASK_AGAIN}`);
  const good = hotels.filter(h => (Number(h.rating) || 0) >= 7.5);
  const ranked = [...(good.length ? good : hotels)].sort((a, b) => value(b, nights) - value(a, nights));
  const top = ranked[0], room = top.rooms[0];
  const plan: Plan = {
    id: 'TRIP-' + Math.random().toString(16).slice(2, 8).toUpperCase(), request, end, currency, attempt: 1,
    hotel: { id: top.id, name: top.name, rating: top.rating ?? null, stars: top.stars ?? null, total: top.cheapest_total, refundable: !!room.refundable, board: room.board ?? null, nights, offer_id: room.offer_id },
    alternatives: ranked.slice(1, 3).map(h => ({ name: h.name, rating: h.rating ?? null, total: h.cheapest_total })),
  };
  return { plan, answer: planAnswer(plan) };
}

function itinerary(plan: Plan) {
  const { destination, days } = plan.request;
  const pool = destination.activities;
  const used = new Set<string>();
  const take = (slot: string) => {
    const options = pool.filter(a => a.slot === slot);
    const fresh = options.find(a => !used.has(a.name)) ?? pool.find(a => !used.has(a.name));
    if (fresh) used.add(fresh.name);
    return fresh;
  };
  const lines: string[] = []; let cost = 0;
  for (let i = 0; i < days; i++) {
    const date = prettyDate(addDays(plan.request.start, i));
    const items: string[] = [];
    const add = (label: string, a?: { name: string; blurb: string; usd: number }) => { if (a) { cost += a.usd; items.push(`${label}: **${a.name}**. ${a.blurb} (${a.usd ? `about $${a.usd}` : 'free'})`); } };
    if (i === 0) {
      items.push(`Arrive in ${destination.name} and check in at ${plan.hotel.name}.`);
      add('Evening', take('evening'));
    } else if (i === days - 1) {
      add('Morning', take('morning'));
      items.push('Check out and head home.');
    } else {
      add('Morning', take('morning')); add('Afternoon', take('afternoon')); add('Evening', take('evening'));
    }
    lines.push(`**Day ${i + 1} · ${date}**`, ...items.map(t => `- ${t}`), '');
  }
  return { lines, cost };
}

function planAnswer(plan: Plan) {
  const { destination, start, days, travellers } = plan.request;
  const nights = days - 1;
  const h = plan.hotel;
  const out: string[] = [
    `# Your ${days}-day trip to ${destination.name}`, '',
    `**${prettyDate(start)} to ${prettyDate(plan.end)}** · ${travellers === 1 ? '1 traveller' : `${travellers} travellers`}`, '',
    ...(plan.request.notes?.length ? ['**Good to know**', ...plan.request.notes.map(n => `- ${n}`), ''] : []),
    '## Where to stay', '',
    `**Top pick: ${h.name}**${h.stars ? ` (${h.stars} stars)` : ''} · ${nights} night${nights === 1 ? '' : 's'} · **${money(h.total)}**`,
    h.rating ? `Guests rate it ${h.rating} out of 10. It is the best mix of happy guests and a good price.` : 'A good price for the area.',
    h.refundable ? 'You can cancel for free for a while.' : 'This price cannot be refunded once booked.'];
  if (plan.alternatives.length) out.push('', '**Also worth a look**', ...plan.alternatives.map(a => `- ${a.name}${a.rating ? ` (${a.rating}/10)` : ''}, ${money(a.total)}`));
  out.push('', '## Day by day', '');
  const trip = itinerary(plan);
  out.push(...trip.lines, '## What it costs', '',
    `- Hotel: **${money(h.total)}**`, trip.cost ? `- Things to do: about **$${trip.cost}** per person (typical prices, paid on the day)` : '- Things to do: all free', '- Flights: not included. I do not search flights for now.', '',
    '**Like it? Just say "book the hotel" and I will reserve my top pick for you.**', '',
    `_Trip code: ${plan.id}. These are test prices, so nothing has been booked or paid yet._`);
  return out.join('\n') + '\n';
}

export interface Deps { travel: Travel; store: Storage; config: Config }
const planKey = (owner: string) => `latest-plan:${owner}`;

export async function savePlan(deps: Deps, owner: string, plan: Plan) {
  const op = (await deps.store.claim('latest-plan', planKey(owner), { owner })).operation;
  await deps.store.finish(op.id, 'ready', plan);
}
async function loadPlan(deps: Deps, owner: string): Promise<{ id: string; plan?: Plan }> {
  const op = (await deps.store.claim('latest-plan', planKey(owner), { owner })).operation;
  return { id: op.id, plan: op.state === 'ready' ? op.response : undefined };
}

export async function bookHotel(deps: Deps, owner: string, intent: Extract<Intent, { kind: 'book' }>, today = new Date()): Promise<string> {
  const loaded = await loadPlan(deps, owner);
  const plan = loaded.plan;
  if (!plan) throw new TaskInputError(`I have no trip to book yet. Ask me to plan one first, for example: "${exampleRequest(today)}".${ASK_AGAIN}`);
  const notes: string[] = [];
  if (intent.flight && !intent.hotel) return `# I do not handle flights\n\nI plan activities and recommend and book hotels only. Flights are switched off for now, so please book them with an airline. Nothing was booked.\n\nTo reserve the hotel from your plan, say "book the hotel".\n`;
  if (intent.flight) notes.push('I do not book flights, so I only booked the hotel.');
  if (plan.booked) return bookedAnswer(plan, true, notes);
  if (plan.request.start <= today.toISOString().slice(0, 10)) throw new TaskInputError(`The dates in your last plan (${prettyDate(plan.request.start)}) are too close or already gone, so I cannot book it. Ask for a new plan, for example: "${exampleRequest(today)}".${ASK_AGAIN}`);
  // The built-in guest is a placeholder. Never put a made-up person on a booking: ask whose name it should be.
  const placeholder = deps.config.GUEST_GIVEN_NAME === 'Alex' && deps.config.GUEST_FAMILY_NAME === 'Traveller';
  if (!intent.guest && placeholder) throw new TaskInputError(`Whose name should go on the hotel booking? Say, for example: "book the hotel under Anna Reyes". You can add an email too.${ASK_AGAIN}`);
  const given = intent.guest?.given_name ?? deps.config.GUEST_GIVEN_NAME, family = intent.guest?.family_name ?? deps.config.GUEST_FAMILY_NAME;
  const guest = { given_name: given, family_name: family, email: intent.guest?.email ?? deps.config.GUEST_EMAIL };
  const { request, hotel } = plan;
  try {
    // Offers expire, so look up today's price for the same hotel, then book with a ceiling of the price we promised plus 10%.
    const fresh: any = await deps.travel.stays({ check_in_date: request.start, check_out_date: plan.end, rooms: [{ adults: request.travellers }], location: { city: request.destination.city, country_code: request.destination.country_code }, currency: plan.currency, guest_nationality: 'US', limit: 20 });
    const found = fresh.data.hotels.find((h: any) => h.id === hotel.id);
    const rooms: any[] = found?.rooms ?? [];
    const room = rooms.find(r => r.refundable === hotel.refundable && r.board === hotel.board) ?? rooms[0];
    if (!room) throw new ApiError(409, 'NO_ROOM', 'No room left at this hotel.');
    const ceiling = (Number(hotel.total.amount) * 1.1).toFixed(2);
    const input: StayBooking = { offer_id: room.offer_id, guests: [{ ...guest, occupancy_number: 1 }], max_total: { amount: ceiling, currency: hotel.total.currency }, confirm: true };
    const result: any = await journaledBooking(deps.store, deps.config, 'stay', `plan-${plan.id}-hotel-${plan.attempt}`, { plan: plan.id, attempt: plan.attempt }, (id, submitted) => deps.travel.bookStay(input, id, submitted));
    plan.booked = { booking_id: String(result.data.id), confirmation_code: result.data.confirmation_code ?? null, guest: `${given} ${family}`, total: result.data.total, operation_id: result.operation_id };
    await savePlan(deps, owner, plan);
    return bookedAnswer(plan, false, notes);
  } catch (error: any) {
    if (error instanceof TaskInputError) throw error;
    const state = error?.details?.state;
    if (state === 'uncertain') return `# Please wait before trying again\n\nI sent your booking but did not get an answer back. To be safe, I will not try again on my own. Please ask the team to check booking ${error.details.operation_id} before you book again.\n`;
    plan.attempt += 1; await savePlan(deps, owner, plan);
    const why = error.code === 'PRICE_OVER_BUDGET' ? 'The price went up by more than 10% since I made your plan, so I did not book it.' : error.code === 'RATE_CHANGED' ? 'The hotel changed its cancellation rules, so I did not book it.' : error.code === 'NO_ROOM' ? 'The hotel has no rooms left for those dates.' : 'The hotel did not accept the booking.';
    return `# Your hotel is not booked\n\n${why} Nothing was charged.\n\nSay "plan a trip to ${request.destination.name} for ${request.days} days from ${prettyDate(request.start).replace(/^\w+, /, '')}" and I will find you a fresh plan.\n`;
  }
}

function bookedAnswer(plan: Plan, again: boolean, notes: string[]) {
  const b = plan.booked!, h = plan.hotel;
  return [
    again ? '# Your hotel is already booked' : '# Your hotel is booked', '',
    `**${h.name}**, ${plan.request.destination.name}`,
    `- **Check in:** ${prettyDate(plan.request.start)}`, `- **Check out:** ${prettyDate(plan.end)} (${h.nights} night${h.nights === 1 ? '' : 's'})`,
    `- **Guest:** ${b.guest}`, `- **Price:** ${money(b.total)}`, '',
    `**Booking number: ${b.booking_id}**`, b.confirmation_code ? `**Confirmation code: ${b.confirmation_code}**` : '',
    '', 'Keep these two numbers. Show them at the hotel desk when you arrive.', '',
    h.refundable ? 'You can cancel for free for a while, so check the hotel rules if your plans change.' : 'This booking cannot be refunded.',
    ...(notes.length ? ['', ...notes] : []), '',
    '_This was a practice booking in test mode. No real room was reserved and no money was taken._',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n') + '\n';
}

const looksLikeJson = (text: string) => /^\s*(\{|```)/.test(text);

// One entry point for a Sokosumi task: JSON trip searches keep working; plain sentences get a plan or a booking.
export async function answerTask(description: string, deps: Deps, owner: string, baseUrl: string) {
  if (looksLikeJson(description)) {
    if (!deps.config.FLIGHTS_ENABLED && /"flights"\s*:/.test(description)) throw new TaskInputError('I do not search flights for now. Remove the "flights" part and I will search hotels, or describe your trip in words, for example: "Plan a trip to Cebu for 3 days from 9 November".' + ASK_AGAIN);
    const output = await runTravelTask(description, baseUrl, (async (_url, options) => Response.json(await deps.travel.trip(JSON.parse(String(options?.body))))) as typeof fetch);
    return { answer: output.answer, summary: output.result.summary };
  }
  const intent = parseMessage(description);
  if (intent.kind === 'redirect') return { answer: intent.message, summary: { action: 'redirect' } };
  if (intent.kind === 'book') return { answer: await bookHotel(deps, owner, intent), summary: { action: 'book' } };
  const { plan, answer } = await buildPlan(intent.request, deps.travel);
  await savePlan(deps, owner, plan);
  return { answer, summary: { action: 'plan', trip_code: plan.id } };
}

// A reply to an "I need more information" question. A reply that is a complete request stands alone
// ("Plan a trip to Bali ..."); otherwise it completes the original ("from 9 November").
export async function answerFollowUp(original: string, reply: string, deps: Deps, owner: string, baseUrl: string) {
  let alone: Awaited<ReturnType<typeof answerTask>> | undefined;
  try { alone = await answerTask(reply, deps, owner, baseUrl); }
  catch (error) { if (!(error instanceof TaskInputError)) throw error; }
  if (alone && alone.summary.action !== 'redirect') return alone;
  return await answerTask(`${original.trim()} ${reply.trim()}`, deps, owner, baseUrl);
}
