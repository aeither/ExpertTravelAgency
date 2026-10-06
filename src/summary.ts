// Turns raw supplier search output into the short itinerary a buyer actually reads.
const minutes = (iso: unknown) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(String(iso ?? ''));
  return m ? Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
};
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function summarizeFlight(offer: any) {
  const slice = offer?.slices?.[0];
  const segments: any[] = slice?.segments ?? [];
  return {
    offer_id: offer?.id ?? null,
    airline: offer?.owner?.name ?? null,
    total: { amount: String(offer?.total_amount ?? ''), currency: String(offer?.total_currency ?? '') },
    duration_minutes: minutes(slice?.duration),
    stops: Math.max(segments.length - 1, 0),
    departs_at: segments[0]?.departing_at ?? null,
    arrives_at: segments.at(-1)?.arriving_at ?? null,
    route: slice ? `${slice.origin?.iata_code ?? '?'}→${slice.destination?.iata_code ?? '?'}` : null,
  };
}

export function summarizeTrip(results: Record<string, any>) {
  const summary: Record<string, unknown> = {};
  const offers: any[] = results.flights?.data?.offers ?? [];
  if (offers.length) {
    const priced = offers.filter(o => num(o.total_amount) !== null);
    const cheapest = [...priced].sort((a, b) => num(a.total_amount)! - num(b.total_amount)!)[0];
    const timed = priced.filter(o => minutes(o.slices?.[0]?.duration) !== null);
    const fastest = [...timed].sort((a, b) => minutes(a.slices[0].duration)! - minutes(b.slices[0].duration)!)[0];
    summary.flights = { offers_found: offers.length, cheapest: cheapest && summarizeFlight(cheapest), fastest: fastest && summarizeFlight(fastest) };
  }
  const hotels: any[] = results.stays?.data?.hotels ?? [];
  if (hotels.length) {
    const priced = hotels.filter(h => num(h.cheapest_total?.amount) !== null);
    const top = [...priced].sort((a, b) => (num(b.rating) ?? 0) - (num(a.rating) ?? 0) || num(a.cheapest_total.amount)! - num(b.cheapest_total.amount)!).slice(0, 3);
    summary.hotels = {
      hotels_found: hotels.length,
      cheapest: priced.length ? [...priced].sort((a, b) => num(a.cheapest_total.amount)! - num(b.cheapest_total.amount)!).map(h => ({ id: h.id, name: h.name, total: h.cheapest_total }))[0] : null,
      top_rated: top.map(h => ({ id: h.id, name: h.name, stars: h.stars, rating: h.rating, total: h.cheapest_total, refundable: !!h.rooms?.[0]?.refundable })),
    };
  }
  const f: any = (summary.flights as any)?.cheapest, h: any = (summary.hotels as any)?.cheapest;
  if (f && h) {
    // Only add prices in the same currency; never convert silently.
    summary.estimated_total = f.total.currency === h.total.currency
      ? { amount: (num(f.total.amount)! + num(h.total.amount)!).toFixed(2), currency: f.total.currency, basis: 'cheapest flight + cheapest hotel' }
      : { amount: null, currency: null, basis: `flight in ${f.total.currency}, hotel in ${h.total.currency}; not converted` };
  }
  return summary;
}
