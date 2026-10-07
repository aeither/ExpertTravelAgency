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

// FastAPI validation errors arrive as a list of {loc, msg}: keep them readable so a 400 says which field is wrong.
const detailText = (detail: unknown) => typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => [d?.loc?.slice(1).join('.'), d?.msg].filter(Boolean).join(': ')).join('; ') || undefined : undefined;

const LODGING = ['', 'APART_HOTEL'];

// The agent searches, then saves its plan with the identical search a few seconds later. Answer that repeat from memory.
// Kept short on purpose: the checkout step searches again later and must see fresh offers. Failures are never kept.
const SEARCH_TTL_MS = 15000;

export class Advisor {
  private recent = new Map<string, { at: number; found: Promise<any> }>();
  constructor(private config: Config, private request: typeof fetch = fetch) {}
  get enabled() { return !!this.config.ADVISOR_URL; }
  private async post(path: string, body: unknown) {
    const response = await this.request(this.config.ADVISOR_URL.replace(/\/$/, '') + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(502, 'ADVISOR_FAILED', detailText(payload.detail) ?? `The hotel agent returned HTTP ${response.status}.`, undefined, response.status >= 500);
    return payload;
  }
  private search(body: { destination: string; check_in: string; check_out: string; adults: number; lodging: string; payment_type: string }) {
    const key = JSON.stringify(body), now = Date.now();
    for (const [k, v] of this.recent) if (now - v.at > SEARCH_TTL_MS) this.recent.delete(k);
    const hit = this.recent.get(key);
    if (hit) return hit.found;
    const found = this.post('/hotels/search', body);
    this.recent.set(key, { at: now, found });
    found.catch(() => { if (this.recent.get(key)?.found === found) this.recent.delete(key); });
    return found;
  }
  // The agent only opens a checkout for a stay found with the same lodging filter, and offers differ between filters.
  // So search both ways, and remember which filter found each stay.
  async searchStays(input: StaySearch) {
    const nights = Math.max(1, Math.round((Date.parse(input.check_out_date) - Date.parse(input.check_in_date)) / 86400000));
    const search = (lodging: string) => this.search({ destination: 'city' in input.location ? input.location.city : '', check_in: input.check_in_date, check_out: input.check_out_date, adults: input.rooms?.[0]?.adults ?? 2, payment_type: 'PAY_LATER', lodging });
    const settled = await Promise.allSettled(LODGING.map(search));
    const ok = settled.flatMap((r, i) => r.status === 'fulfilled' ? [{ lodging: LODGING[i]!, found: r.value }] : []);
    if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
    const seen = new Set<string>();
    const hotels = ok.flatMap(({ lodging, found }) => (found.stays ?? []).flatMap((s: any) => {
      const nightly = price(s.price);
      if (!nightly || !s.property_id || seen.has(String(s.property_id))) return [];
      seen.add(String(s.property_id));
      const total = { amount: (nightly.amount * nights).toFixed(2), currency: nightly.currency };
      return [{ id: String(s.property_id), lodging, name: s.name ?? `Hotel ${s.property_id}`, rating: null, stars: null, url: s.url ?? null, nightly: { amount: nightly.amount.toFixed(2), currency: nightly.currency }, cheapest_total: total, rooms: [{ offer_id: String(s.property_id), board: null, refundable: !!s.free_cancellation, total }] }];
    }));
    return { hotels, heading: ok[0]!.found.heading ?? null, source: 'Hotels.com via Expert Travel Advisor' };
  }
  // Opens checkout for one property. Returns what the agent said, whether or not it worked.
  async checkout(input: { destination: string; check_in: string; check_out: string; adults: number; property_id: string; lodging?: string }) {
    try {
      const result = await this.post('/hotels/book', { destination: input.destination, check_in: input.check_in, check_out: input.check_out, adults: input.adults, payment_type: 'PAY_LATER', lodging: input.lodging ?? '', property_id: input.property_id });
      const c = result.checkout ?? {};
      const opened = !!(c.checkout_url || c.trip_id);
      if (opened) return { opened, link_only: false, trip_id: c.trip_id ?? null, checkout_url: c.checkout_url ?? null, total: c.total ?? null, failure_reason: c.failure_reason ?? null };
      // The deployed advisor reports a failed checkout at the top level and still returns the pre-filled hotel page. That page is a link, not a checkout.
      const page = (result.stays ?? []).find((s: any) => String(s.property_id) === input.property_id)?.url ?? result.stays?.[0]?.url;
      const link = typeof page === 'string' && page.startsWith('https://') ? page : null;
      const reason = c.failure_reason ?? (typeof result.checkout_error === 'string' ? result.checkout_error : null);
      return { opened: false, link_only: !!link, trip_id: null, checkout_url: link, total: null, failure_reason: reason };
    } catch (error: any) {
      return { opened: false, link_only: false, trip_id: null, checkout_url: null, total: null, failure_reason: String(error?.message ?? 'Checkout failed.') };
    }
  }
}
