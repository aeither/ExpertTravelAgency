import type { FlightSearch, StaySearch, StayBooking } from '../schemas.js';
import { ApiError } from '../errors.js';
import { requireBudget } from '../money.js';
import { randomUUID } from 'node:crypto';

// Synthetic data is available only with TRAVEL_MODE=demo.
export class Demo {
  private offers = new Map<string, any>();
  private bookings = new Map<string, any>();
  flightSearch(input: FlightSearch) {
    const id = `off_demo_${randomUUID()}`;
    const passengers = input.passengers.map((p, i) => ({ ...p, id: `pas_demo_${i}` }));
    const offer = { id, live_mode: false, owner: { name: 'Demo airline' }, total_amount: '180.00', total_currency: 'USD', expires_at: new Date(Date.now() + 900000).toISOString(), passengers, slices: input.slices, conditions: { refund_before_departure: null } };
    this.offers.set(id, offer);
    return { id: `orq_demo_${randomUUID()}`, offers: [offer], passengers, live_mode: false };
  }
  offer(id: string) { return this.get(this.offers, id); }
  staySearch(input: StaySearch) {
    const total = { amount: '240.00', currency: input.currency };
    return { hotels: [{ id: 'lp_demo', name: 'Demo stay', stars: 4, rating: 8.5, review_count: 100, address: '1 Demo Street', city: 'city' in input.location ? input.location.city : null, country_code: 'city' in input.location ? input.location.country_code : null, latitude: null, longitude: null, photo: null, cheapest_total: total, rooms: [{ rate_id: 'rate_demo', offer_id: 'offer_demo', name: 'Demo room', board: 'Room Only', adults: input.rooms[0].adults, children: 0, total, taxes_included: true, refundable: true, free_cancellation_until: null }] }] };
  }
  book(kind: string, input: any, operationId: string) {
    const quote = this.offer(input.offer_id);
    requireBudget(quote.total_amount, quote.total_currency, input.max_total);
    const booking = { id: `booking_demo_${operationId}`, status: 'simulated', provider: 'demo', kind, amount: quote.total_amount, currency: quote.total_currency, operation_id: operationId };
    this.bookings.set(booking.id, booking); return booking;
  }
  bookStay(input: StayBooking, operationId: string) {
    requireBudget('240.00', 'USD', input.max_total);
    const booking = { id: `booking_demo_${operationId}`, status: 'simulated', provider: 'demo', kind: 'stay', amount: '240.00', currency: 'USD', operation_id: operationId };
    this.bookings.set(booking.id, booking); return booking;
  }
  hotelDetails(id: string) {
    return { id, name: 'Demo stay', stars: 4, rating: 8.5, review_count: 100, description: 'Synthetic hotel for API tests.', address: '1 Demo Street', city: null, country_code: null, latitude: null, longitude: null, photos: [], facilities: ['WiFi available'], check_in_from: '3:00 PM', check_out_by: '11:00 AM', pets_allowed: false, children_allowed: true, review_highlights: { pros: ['Demo pro'], cons: ['Demo con'] } };
  }
  booking(id: string) { return this.get(this.bookings, id); }
  private get(map: Map<string, any>, id: string) {
    const value = map.get(id); if (!value) throw new ApiError(404, 'DEMO_RESOURCE_NOT_FOUND', 'Demo resource not found. Demo searches reset when the server restarts.');
    return value;
  }
}
