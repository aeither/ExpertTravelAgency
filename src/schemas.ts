import { z } from 'zod';

export const date = z.iso.date();
export const futureDate = date.refine(v => v >= new Date().toISOString().slice(0, 10), 'Date must be today or later.');
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const amount = z.string().regex(/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/);
export const money = z.object({ amount, currency }).strict();
const text = z.string().trim().min(1).max(200);
export const resourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const adultOrChild = z.union([
  z.object({ type: z.literal('adult') }).strict(),
  z.object({ age: z.number().int().min(0).max(17) }).strict(),
]);
export const flightSearch = z.object({
  slices: z.array(z.object({ origin: z.string().regex(/^[A-Z]{3}$/), destination: z.string().regex(/^[A-Z]{3}$/), departure_date: futureDate }).strict()).min(1).max(6),
  passengers: z.array(adultOrChild).min(1).max(9),
  cabin_class: z.enum(['economy', 'premium_economy', 'business', 'first']).default('economy'),
  max_connections: z.number().int().min(0).max(3).optional(),
}).strict().refine(v => v.slices.every((s, i) => s.origin !== s.destination && (i === 0 || s.departure_date >= v.slices[i - 1].departure_date)), 'Use different airports and dates in travel order.');
export const staySearch = z.object({
  check_in_date: futureDate, check_out_date: futureDate,
  rooms: z.array(z.object({ adults: z.number().int().min(1).max(8), children_ages: z.array(z.number().int().min(0).max(17)).max(6).optional() }).strict()).min(1).max(5),
  location: z.union([
    z.object({ city: text, country_code: z.string().regex(/^[A-Z]{2}$/) }).strict(),
    z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radius_m: z.number().int().min(1000).max(50000).default(5000) }).strict(),
  ]),
  currency: currency.default('USD'),
  guest_nationality: z.string().regex(/^[A-Z]{2}$/).default('US'),
  limit: z.number().int().min(1).max(50).default(10),
  // auto: LiteAPI (bookable, rated) when it has rooms, else the Expert Travel Advisor. Internal callers that leave this out keep the legacy source choice.
  provider: z.enum(['auto', 'liteapi', 'advisor']).optional(),
  // Re-price known hotels (LiteAPI only), for example to refresh an offer before booking.
  hotel_ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).min(1).max(20).optional(),
}).strict().refine(v => v.check_out_date > v.check_in_date, 'Check-out must be after check-in.');
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const person = z.object({ given_name: text, family_name: text }).strict();
export const flightBooking = z.object({
  offer_id: resourceId,
  passengers: z.array(person.extend({
    id: resourceId, born_on: date, email: z.email(), phone_number: phone,
    title: z.enum(['mr', 'ms', 'mrs', 'miss', 'dr']), gender: z.enum(['m', 'f']),
    infant_passenger_id: resourceId.optional(),
    identity_documents: z.array(z.object({ type: z.enum(['passport', 'known_traveler_number', 'passenger_redress_number']), unique_identifier: text, issuing_country_code: z.string().regex(/^[A-Z]{2}$/).optional(), expires_on: date.optional() }).strict()).max(5).optional(),
  })).min(1).max(9),
  max_total: money, confirm: z.literal(true),
}).strict();
export const stayBooking = z.object({
  offer_id: z.string().regex(/^[A-Za-z0-9_=-]{20,4000}$/).describe('offer_id from /v1/stays/search'),
  guests: z.array(person.extend({ email: z.email(), occupancy_number: z.number().int().min(1).max(5).default(1) })).min(1).max(10),
  max_total: money, confirm: z.literal(true),
}).strict();
export const tripSearch = z.object({ flights: flightSearch.optional(), stays: staySearch.optional() }).strict().refine(v => v.flights || v.stays, 'Supply at least one search.');
export const idempotencyHeaders = z.object({ 'idempotency-key': z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) }).passthrough();
export type FlightSearch = z.infer<typeof flightSearch>;
export type StaySearch = z.infer<typeof staySearch>;
export type StayBooking = z.infer<typeof stayBooking>;
export type FlightBooking = z.infer<typeof flightBooking>;
export type TripSearch = z.infer<typeof tripSearch>;
