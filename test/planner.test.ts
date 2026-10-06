import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, answerTask, answerFollowUp, bookHotel } from '../src/planner.js';
import { TaskInputError } from '../src/coworker-search.js';
import { Store } from '../src/store.js';
import { getConfig } from '../src/config.js';
import type { Travel } from '../src/travel.js';

const today = new Date('2026-10-06T00:00:00Z');

test('plain sentences become a trip request', () => {
  const intent: any = parseMessage('Plan a trip to Cebu for 3 days from 9 October', today);
  assert.equal(intent.kind, 'plan');
  assert.equal(intent.request.destination.airport, 'CEB');
    assert.equal(intent.request.start, '2026-10-09');
  assert.equal(intent.request.days, 3);
  const other: any = parseMessage('trip from Singapore to Bangkok, October 20th, 4 days, 2 people', today);
  assert.deepEqual([other.request.destination.airport, other.request.start, other.request.days, other.request.travellers], ['BKK', '2026-10-20', 4, 2]);
  assert.equal((parseMessage('cebu from 1 january for 5 days', today) as any).request.start, '2027-01-01');
});

test('missing details get a friendly question', () => {
  assert.throws(() => parseMessage('plan a trip', today), TaskInputError);
  assert.throws(() => parseMessage('go to cebu for 3 days', today), /Which day/);
  assert.equal((parseMessage('I like it, book the hotels', today) as any).kind, 'book');
});

function fixture() {
  let bookings = 0;
  const hotel = { id: 'h1', name: 'Test Hotel', stars: 3, rating: 9, cheapest_total: { amount: '80.00', currency: 'EUR' }, rooms: [{ offer_id: 'offer', board: 'Room only', refundable: true, total: { amount: '80.00', currency: 'EUR' } }] };
  const travel = {
    stays: async () => ({ data: { hotels: [hotel] } }),
    bookStay: async (input: any) => { bookings++; assert.equal(input.max_total.amount, '88.00'); return { data: { id: 'BK123', confirmation_code: 'CONF9', total: { amount: '80.00', currency: 'EUR' } } }; },
  } as unknown as Travel;
  return { travel, bookings: () => bookings };
}

test('plan, then book the hotel once; a repeat does not book again', async () => {
  const store = new Store(':memory:'); const f = fixture(); const deps = { travel: f.travel, store, config: getConfig({}) };
  try {
    await assert.rejects(answerTask('book the hotel', deps, 'u1', 'x'), /no trip to book/);
    const plan = await answerTask('Plan a trip to Cebu for 3 days from 9 October', deps, 'u1', 'x');
    for (const word of ['Where to stay', 'Test Hotel', 'Day 1', 'Day 3', 'Kawasan', 'book the hotel']) assert.match(plan.answer, new RegExp(word));
    assert.doesNotMatch(plan.answer, /sandbox|JSON|offer_id|Duffel/i);
    assert.match(plan.answer, /do not search flights/);
    await assert.rejects(answerTask('I like it, book the hotels', deps, 'u1', 'x'), /Whose name/);
    assert.equal(f.bookings(), 0);
    const booked = await answerTask('I like it, book the hotels under Anna Reyes', deps, 'u1', 'x');
    assert.match(booked.answer, /BK123/); assert.match(booked.answer, /CONF9/);
    assert.match((await answerTask('book the hotel', deps, 'u1', 'x')).answer, /already booked/);
    assert.equal(f.bookings(), 1);
    await assert.rejects(answerTask('book the hotel', deps, 'someone-else', 'x'), /no trip to book/);
  } finally { store.close(); }
});

const ask = (text: string, pattern: RegExp) => assert.throws(() => parseMessage(text, today), (e: any) => e instanceof TaskInputError && pattern.test(e.message), text);
const plan = (text: string) => (parseMessage(text, today) as any).request;

test('missing or unusable details get a specific question that says how to answer', () => {
  ask('Plan a trip to Cebu', /Which day/);
  ask('I want to travel on 12 December', /Where would you like to go/);
  ask('Plan a trip to Tokyo for 4 days from 9 November', /cannot plan trips to Tokyo.*Cebu/);
  ask('Plan a trip to Cebu and Bangkok from 9 November', /one destination at a time.*Which one/);
  ask('Plan a trip to Cebu for 30 days from 9 November', /2 to 14 days/);
  ask('Plan a trip to Cebu for 1 day from 9 November', /2 to 14 days/);
  ask('Plan a trip to Cebu for 3 days from 31 February', /does not exist/);
  ask('Plan a trip to Cebu for 3 days from 5 October 2026', /already passed/);
  ask('Plan a trip to Cebu for 3 days from 9 November 2028', /11 months/);
  ask('Plan a trip to Cebu for 3 days from today', /notice/);
  ask('Plan a trip to Cebu for 3 days on 09/11/2026', /month name/);
  ask('Plan a trip to Cebu for 12 people from 9 November', /up to 4 travellers/);
  ask('Plan a trip to Cebu for 3 days from 9 November with my kids', /only plan for adults/);
  assert.equal(plan('Plan a trip to Manila for 3 days from 9 November').destination.name, 'Manila');
  ask('', /task is empty/);
  ask('x'.repeat(2001), /shorten/);
  for (const text of ['Plan a trip to Cebu', 'Plan a trip to Tokyo from 9 November']) ask(text, /Reply on this task, or create a new task/);
});

test('natural ways of saying dates, lengths and group sizes are understood', () => {
  const dates = (text: string) => [plan(text).start, plan(text).days, plan(text).travellers];
  assert.deepEqual(dates('Plan a trip to Cebu for 3 nights from 9 November'), ['2026-11-09', 4, 1]);
  assert.deepEqual(dates('Cebu from 9-12 November'), ['2026-11-09', 4, 1]);
  assert.deepEqual(dates('Cebu 9 to 12 November for 5 days'), ['2026-11-09', 5, 1]);
  assert.deepEqual(dates('Plan a trip to Bali for a week from November 9th, 2 adults'), ['2026-11-09', 7, 2]);
  assert.deepEqual(dates('Plan a trip to Cebu for two weeks from 2026-11-09 for a family of four'), ['2026-11-09', 14, 4]);
  assert.deepEqual(dates('weekend in Cebu from 9 November for me and my wife'), ['2026-11-09', 3, 2]);
  assert.equal(plan('Plan a trip to Cebu for 3 days tomorrow').start, '2026-10-07');
  assert.equal(plan('Plan a trip to Cebu for 3 days from 1 February').start, '2027-02-01');
  ask('Plan a trip to Cebu for 3 days from 1 October', /already passed/);
});

test('assumptions and ignored preferences are said out loud in the plan', () => {
  const rolled = plan('Plan a trip to Cebu from 1 February');
  assert.match(rolled.notes.join(' '), /1 Feb 2027/);
  assert.match(rolled.notes.join(' '), /planned 3 days/);
  const picky = plan('Plan a trip to Cebu for 3 days from 9 November in business class under $500, do I need a visa?');
  for (const word of ['flights', 'budget', 'visa']) assert.match(picky.notes.join(' '), new RegExp(word));
  assert.match(plan('Please book a trip to Cebu for 3 days from 9 November').notes.join(' '), /plan first and book second/);
  assert.equal(plan('Plan a trip to Cebu for 3 days from 9 November').notes, undefined);
});

test('out of scope requests are redirected with what the coworker can do, not left waiting', async () => {
  for (const text of ['hello', 'help', 'what can you do?', 'what is the weather in Cebu?', 'do I need a visa for Bali?', 'cancel my booking', 'please change the hotel dates']) {
    const intent: any = parseMessage(text, today);
    assert.equal(intent.kind, 'redirect', text);
    assert.match(intent.message, /Cebu|Bangkok/); assert.match(intent.message, /Try: "Plan a trip to Cebu for 3 days from/);
  }
  assert.equal((parseMessage('cancel my booking', today) as any).message.includes('contact the hotel'), true);
  const store = new Store(':memory:');
  try { assert.equal((await answerTask('hello', { travel: fixture().travel, store, config: getConfig({}) }, 'u1', 'x')).summary.action, 'redirect'); } finally { store.close(); }
});

test('a booking request that already has the trip details is planned first, never booked blind', async () => {
  const intent: any = parseMessage('Please book a trip to Cebu for 3 days from 9 November', today);
  assert.equal(intent.kind, 'plan');
  const guest: any = parseMessage('book the hotel under the name Anna Reyes, anna@example.com', today);
  assert.deepEqual([guest.guest.given_name, guest.guest.family_name, guest.guest.email], ['Anna', 'Reyes', 'anna@example.com']);
});

test('asking for a flight booking never books the hotel', async () => {
  const store = new Store(':memory:'); const f = fixture(); const deps = { travel: f.travel, store, config: getConfig({}) };
  try {
    await answerTask('Plan a trip to Cebu for 3 days from 9 October', deps, 'u1', 'x');
    const reply = await answerTask('book me a flight', deps, 'u1', 'x');
    assert.match(reply.answer, /do not handle flights/); assert.equal(f.bookings(), 0);
    const both = await answerTask('book the flight and the hotel under Anna Reyes', deps, 'u1', 'x');
    assert.match(both.answer, /BK123/); assert.match(both.answer, /do not book flights/); assert.equal(f.bookings(), 1);
  } finally { store.close(); }
});

test('a plan whose dates have passed is not booked', async () => {
  const store = new Store(':memory:'); const f = fixture(); const deps = { travel: f.travel, store, config: getConfig({}) };
  try {
    await answerTask('Plan a trip to Cebu for 3 days from 9 October', deps, 'u1', 'x');
    await assert.rejects(bookHotel(deps, 'u1', { kind: 'book', flight: false, hotel: true, guest: { given_name: 'Anna', family_name: 'Reyes' } }, new Date('2026-10-09T00:00:00Z')), /too close or already gone/);
    assert.equal(f.bookings(), 0);
  } finally { store.close(); }
});

test('a hotel search with no rooms asks for other dates instead of failing', async () => {
  const store = new Store(':memory:'); const f = fixture();
  const travel = { ...f.travel, stays: async () => ({ data: { hotels: [] } }) } as unknown as Travel;
  try { await assert.rejects(answerTask('Plan a trip to Cebu for 3 days from 9 October', { travel, store, config: getConfig({}) }, 'u1', 'x'), (e: any) => e instanceof TaskInputError && /other dates/.test(e.message)); } finally { store.close(); }
});

test('a reply that completes the request is joined to the original, and a full new request replaces it', async () => {
  const store = new Store(':memory:'); const f = fixture(); const deps = { travel: f.travel, store, config: getConfig({}) };
  try {
    const joined = await answerFollowUp('Plan a trip to Cebu', 'from 9 October', deps, 'u1', 'x');
    assert.match(joined.answer, /Cebu/);
    const replaced = await answerFollowUp('Plan a trip to Cebu', 'Plan a trip to Bali for 4 days from 9 October', deps, 'u1', 'x');
    assert.match(replaced.answer, /Bali/);
    await assert.rejects(answerFollowUp('Plan a trip to Cebu', 'soon', deps, 'u1', 'x'), /Which day/);
  } finally { store.close(); }
});

test('flights are switched off: no flight search is made and flight JSON is refused', async () => {
  const store = new Store(':memory:'); const f = fixture(); const deps = { travel: f.travel, store, config: getConfig({}) };
  try {
    const plan = await answerTask('Plan a trip to Cebu for 3 days from 9 October', deps, 'u1', 'x');
    assert.doesNotMatch(plan.answer, /Test Air|Going:|Coming back/);
    await assert.rejects(answerTask('{"flights":{"slices":[]}}', deps, 'u1', 'x'), /do not search flights/);
  } finally { store.close(); }
});

// Hotel source: the Expert Travel Advisor agent (mocked HTTP). Checkout only opens a checkout and never claims a booking.
import { Advisor } from '../src/providers/advisor.js';
import { getConfig as advisorConfig } from '../src/config.js';
test('advisor hotels are priced per night, ranked by price, and checkout failure is reported honestly', async () => {
  const config = advisorConfig({ ADVISOR_URL: 'https://advisor.test', FLIGHTS_ENABLED: 'false' });
  const calls: string[] = [];
  const request = (async (url: string, options: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/hotels/search')) return Response.json({ status: 'completed', heading: '3 Properties', stays: [{ property_id: '1', name: 'Cheap Hut', price: '$40', free_cancellation: true, url: 'https://hotels.test/1' }, { property_id: '2', name: 'Pricey', price: '$90', free_cancellation: true, url: null }] });
    return Response.json({ detail: 'The selected stay has no offer to open' }, { status: 502 });
  }) as typeof fetch;
  const advisor = new Advisor(config, request);
  const found = await advisor.searchStays({ check_in_date: '2026-10-20', check_out_date: '2026-10-22', rooms: [{ adults: 1 }], location: { city: 'Cebu', country_code: 'PH' } } as any);
  assert.equal(found.hotels[0]!.cheapest_total.amount, '80.00'); // $40 x 2 nights
  assert.equal(found.hotels[0]!.rooms[0]!.refundable, true);
  const result = await advisor.checkout({ destination: 'Cebu', check_in: '2026-10-20', check_out: '2026-10-22', adults: 1, property_id: '1' });
  assert.equal(result.opened, false); assert.match(result.failure_reason!, /no offer/);
});
