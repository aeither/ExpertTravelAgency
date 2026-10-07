import type { Config } from '../config.js';
import { ApiError, unavailable } from '../errors.js';
import { HttpClient } from '../http.js';
import { requireBudget } from '../money.js';
import type { StaySearch, StayBooking } from '../schemas.js';

const amountOf = (prices: any) => Array.isArray(prices) && prices[0] ? { amount: String(prices[0].amount), currency: String(prices[0].currency) } : null;

export class LiteApi {
  constructor(private config: Config, private http: HttpClient) {}
  get sandbox() { return this.config.LITEAPI_API_KEY.startsWith('sand_'); }
  private async call(path: string, body?: unknown) {
    if (!this.config.LITEAPI_API_KEY) unavailable('LiteAPI', 'LITEAPI_API_KEY');
    return this.http.request('https://api.liteapi.travel/v3.0', path, { 'X-API-Key': this.config.LITEAPI_API_KEY, Accept: 'application/json' }, body);
  }
  async bookStay(input: StayBooking, operationId: string, markSubmitted: () => Promise<void>) {
    if (!this.sandbox && !this.config.LIVE_BOOKINGS_ALLOWED) throw new ApiError(403, 'LIVE_BOOKINGS_DISABLED', 'Live bookings are disabled. Use a LiteAPI sandbox key.');
    // Prebook first: it returns the price LiteAPI will actually charge and flags any rate change.
    const pre = (await this.call('/rates/prebook', { offerId: input.offer_id, usePaymentSdk: false }))?.data;
    if (!pre?.prebookId) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'LiteAPI did not return a prebook.');
    if (pre.cancellationChanged || pre.boardChanged) throw new ApiError(409, 'RATE_CHANGED', 'The cancellation terms or board changed. Search again.');
    if (!Array.isArray(pre.paymentTypes) || !pre.paymentTypes.includes('WALLET')) throw new ApiError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'This rate cannot be paid from the account balance.');
    requireBudget(String(pre.sellingPriceToUser ?? pre.price), String(pre.currency), input.max_total);
    // The journal is committed before the supplier booking request.
    await markSubmitted();
    const holder = input.guests[0];
    const booked = (await this.call('/rates/book', {
      prebookId: pre.prebookId, clientReference: operationId, payment: { method: 'WALLET' },
      holder: { firstName: holder.given_name, lastName: holder.family_name, email: holder.email },
      guests: input.guests.map(g => ({ occupancyNumber: g.occupancy_number, firstName: g.given_name, lastName: g.family_name, email: g.email })),
    }))?.data;
    if (!booked?.bookingId) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'LiteAPI did not confirm the booking.', undefined, true);
    return { id: booked.bookingId, status: booked.status, confirmation_code: booked.hotelConfirmationCode ?? null, hotel: booked.hotel?.name ?? null, checkin: booked.checkin, checkout: booked.checkout, total: { amount: String(pre.sellingPriceToUser ?? pre.price), currency: String(pre.currency) }, sandbox: this.sandbox, operation_id: operationId };
  }
  // Static content: photos, facilities, review themes. Cached by the supplier, so safe to call per hotel.
  async hotelDetails(id: string) {
    const data = (await this.call(`/data/hotel?hotelId=${encodeURIComponent(id)}`))?.data;
    if (!data?.id) throw new ApiError(404, 'HOTEL_NOT_FOUND', 'LiteAPI has no hotel with this id.');
    const text = (html: unknown) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const sentiment = data.sentiment_analysis;
    return {
      id: data.id, name: data.name, stars: data.starRating ?? null, rating: data.rating ?? null, review_count: data.reviewCount ?? null,
      description: text(data.hotelDescription).slice(0, 600) || null,
      address: data.address ?? null, city: data.city ?? null, country_code: data.country ?? null,
      latitude: data.location?.latitude ?? null, longitude: data.location?.longitude ?? null,
      photos: (data.hotelImages ?? []).slice(0, 8).map((i: any) => ({ url: i.urlHd || i.url, caption: i.caption || null })),
      facilities: (data.hotelFacilities ?? []).slice(0, 20),
      check_in_from: data.checkinCheckoutTimes?.checkin_start || null, check_out_by: data.checkinCheckoutTimes?.checkout || null,
      pets_allowed: data.petsAllowed ?? null, children_allowed: data.childAllowed ?? null,
      review_highlights: sentiment ? { pros: (sentiment.pros ?? []).slice(0, 5), cons: (sentiment.cons ?? []).slice(0, 5) } : null,
    };
  }
  async getStayBooking(id: string) {
    const data = (await this.call(`/bookings/${encodeURIComponent(id)}`))?.data;
    if (!data) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'LiteAPI did not return the booking.');
    return { id: data.bookingId ?? id, status: data.status, confirmation_code: data.hotelConfirmationCode ?? null, hotel: data.hotel?.name ?? null, checkin: data.checkin, checkout: data.checkout, sandbox: this.sandbox };
  }
  async searchStays(input: StaySearch) {
    if (!this.config.LITEAPI_API_KEY) unavailable('LiteAPI', 'LITEAPI_API_KEY');
    const where = input.hotel_ids?.length ? { hotelIds: input.hotel_ids }
      : 'city' in input.location
        ? { cityName: input.location.city, countryCode: input.location.country_code }
        : { latitude: input.location.latitude, longitude: input.location.longitude, radius: input.location.radius_m };
    // LiteAPI answers "no availability" (code 2001) with a 400. That is an empty result, not a failure.
    const response = await this.http.request('https://api.liteapi.travel/v3.0', '/hotels/rates', { 'X-API-Key': this.config.LITEAPI_API_KEY, Accept: 'application/json' }, {
      ...where, checkin: input.check_in_date, checkout: input.check_out_date,
      occupancies: input.rooms.map(r => ({ adults: r.adults, children: r.children_ages ?? [] })),
      currency: input.currency, guestNationality: input.guest_nationality, limit: input.limit, maxRatesPerHotel: 3,
    }).catch(error => {
      if (error instanceof ApiError && error.code === 'UPSTREAM_REJECTED' && (error.details as any)?.upstream_status === 400) return { data: [], hotels: [] };
      throw error;
    });
    if (!Array.isArray(response?.data)) throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'LiteAPI did not return hotel rates.');
    const details = new Map<string, any>((response.hotels ?? []).map((h: any) => [h.id, h]));
    return {
      hotels: response.data.map((entry: any) => {
        const info = details.get(entry.hotelId) ?? {};
        const rooms = (entry.roomTypes ?? []).flatMap((type: any) => (type.rates ?? []).map((rate: any) => ({
          rate_id: rate.rateId, offer_id: type.offerId, name: rate.name, board: rate.boardName,
          adults: rate.adultCount, children: rate.childCount,
          total: amountOf(rate.retailRate?.total), taxes_included: rate.retailRate?.taxesAndFees?.every((t: any) => t.included) ?? null,
          refundable: rate.cancellationPolicies?.refundableTag === 'RFN',
          free_cancellation_until: rate.cancellationPolicies?.cancelPolicyInfos?.[0]?.cancelTime ?? null,
        })));
        rooms.sort((a: any, b: any) => Number(a.total?.amount ?? Infinity) - Number(b.total?.amount ?? Infinity));
        return {
          id: entry.hotelId, name: info.name ?? null, stars: info.stars ?? null, rating: info.rating ?? null, review_count: info.review_count ?? null,
          address: info.address ?? null, city: info.city_name ?? null, country_code: info.country_code ?? null,
          latitude: info.latitude ?? null, longitude: info.longitude ?? null, photo: info.main_photo ?? null,
          cheapest_total: rooms[0]?.total ?? null, rooms,
        };
      }),
    };
  }
}
