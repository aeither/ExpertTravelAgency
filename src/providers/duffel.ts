import type { Config } from '../config.js';
import { ApiError, unavailable } from '../errors.js';
import { HttpClient } from '../http.js';
import { requireBudget } from '../money.js';
import type { FlightSearch, FlightBooking } from '../schemas.js';

export class Duffel {
  constructor(private config: Config, private http: HttpClient) {}
  get live() { return this.config.DUFFEL_ACCESS_TOKEN.startsWith('duffel_live_'); }
  private async call(path: string, data?: unknown, method?: string) {
    if (!this.config.DUFFEL_ACCESS_TOKEN) unavailable('Duffel', 'DUFFEL_ACCESS_TOKEN');
    const response = await this.http.request('https://api.duffel.com', path, {
      Authorization: `Bearer ${this.config.DUFFEL_ACCESS_TOKEN}`, Accept: 'application/json', 'Duffel-Version': 'v2',
    }, data === undefined ? undefined : { data }, method);
    if (response?.data === undefined) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Duffel did not return data.', undefined, true);
    return response.data;
  }
  private bookingAccess() {
    if (this.live && !this.config.LIVE_BOOKINGS_ALLOWED) throw new ApiError(403, 'LIVE_BOOKINGS_DISABLED', 'Live bookings are disabled. Use a Duffel test token.');
  }
  searchFlights(input: FlightSearch) { return this.call('/air/offer_requests?return_offers=true', input); }
  getOffer(id: string) { return this.call(`/air/offers/${encodeURIComponent(id)}`); }
  async bookFlight(input: FlightBooking, operationId: string, markSubmitted: () => Promise<void>) {
    this.bookingAccess();
    const offer = await this.getOffer(input.offer_id);
    this.verifyMode(offer);
    this.checkExpiry(offer.expires_at);
    requireBudget(offer.total_amount, offer.total_currency, input.max_total);
    const expected = new Set((offer.passengers ?? []).map((p: any) => p.id));
    const actual = new Set(input.passengers.map(p => p.id));
    if (expected.size === 0 || expected.size !== actual.size || actual.size !== input.passengers.length || [...expected].some(id => !actual.has(id as string))) {
      throw new ApiError(400, 'PASSENGER_MISMATCH', 'Supply each passenger ID from the selected offer once.');
    }
    // The journal is committed before the supplier booking request.
    await markSubmitted();
    return this.call('/air/orders', {
      type: 'instant', selected_offers: [input.offer_id], passengers: input.passengers,
      payments: [{ type: 'balance', amount: offer.total_amount, currency: offer.total_currency }],
      metadata: { origin_operation_id: operationId },
    });
  }
  getFlightBooking(id: string) { return this.call(`/air/orders/${encodeURIComponent(id)}`); }
  private verifyMode(data: any) {
    if (typeof data.live_mode !== 'boolean' || data.live_mode !== this.live) throw new ApiError(502, 'SUPPLIER_MODE_MISMATCH', 'The offer mode does not match the Duffel token.');
  }
  private checkExpiry(value: unknown) {
    if (value === undefined) return;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new ApiError(409, 'QUOTE_EXPIRED', 'Request a new offer or quote.');
  }
}
