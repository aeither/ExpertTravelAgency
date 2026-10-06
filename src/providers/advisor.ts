import { ApiError } from '../errors.js';
import type { Config } from '../config.js';
import type { StaySearch } from '../schemas.js';

// The Expert Travel Advisor agent (Hotels.com, pay at the property). Used as the hotel source instead of LiteAPI.
// Its prices are per night; its checkout only opens a pay-at-property checkout and never confirms a reservation.
const price = (text: string | null | undefined) => {
  const m = /(US\$|\$|€|£|[A-Z]{3})\s?([\d,]+(?:\.\d+)?)/.exec(text ?? '');
  if (!m) return undefined;
  const symbol = m[1]!, currency = { $: 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP' }[symbol] ?? symbol;
  return { amount: Number(m[2]!.replace(/,/g, '')), currency };
};

export class Advisor {
  constructor(private config: Config, private request: typeof fetch = fetch) {}
  get enabled() { return !!this.config.ADVISOR_URL; }
  private async post(path: string, body: unknown) {
    const response = await this.request(this.config.ADVISOR_URL.replace(/\/$/, '') + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(502, 'ADVISOR_FAILED', typeof payload.detail === 'string' ? payload.detail : `The hotel agent returned HTTP ${response.status}.`, undefined, response.status >= 500);
    return payload;
  }
  async searchStays(input: StaySearch) {
    const nights = Math.max(1, Math.round((Date.parse(input.check_out_date) - Date.parse(input.check_in_date)) / 86400000));
    const found = await this.post('/hotels/search', { destination: 'city' in input.location ? input.location.city : '', check_in: input.check_in_date, check_out: input.check_out_date, adults: input.rooms?.[0]?.adults ?? 2 });
    const hotels = (found.stays ?? []).flatMap((s: any) => {
      const nightly = price(s.price);
      if (!nightly || !s.property_id) return [];
      const total = { amount: (nightly.amount * nights).toFixed(2), currency: nightly.currency };
      return [{ id: String(s.property_id), name: s.name ?? `Hotel ${s.property_id}`, rating: null, stars: null, url: s.url ?? null, nightly: { amount: nightly.amount.toFixed(2), currency: nightly.currency }, cheapest_total: total, rooms: [{ offer_id: String(s.property_id), board: null, refundable: !!s.free_cancellation, total }] }];
    });
    return { hotels, heading: found.heading ?? null, source: 'Hotels.com via Expert Travel Advisor' };
  }
  // Opens checkout for one property. Returns what the agent said, whether or not it worked.
  async checkout(input: { destination: string; check_in: string; check_out: string; adults: number; property_id: string }) {
    try {
      const result = await this.post('/hotels/book', input);
      const c = result.checkout ?? {};
      return { opened: !!(c.checkout_url || c.trip_id), trip_id: c.trip_id ?? null, checkout_url: c.checkout_url ?? null, total: c.total ?? null, failure_reason: c.failure_reason ?? null };
    } catch (error: any) {
      return { opened: false, trip_id: null, checkout_url: null, total: null, failure_reason: String(error?.message ?? 'Checkout failed.') };
    }
  }
}
