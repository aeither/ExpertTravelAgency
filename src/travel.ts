import type { Config } from './config.js';
import { HttpClient } from './http.js';
import { Duffel } from './providers/duffel.js';
import { LiteApi } from './providers/liteapi.js';
import { Advisor } from './providers/advisor.js';
import { Demo } from './providers/demo.js';
import { ApiError, unavailable } from './errors.js';
import { summarizeTrip } from './summary.js';
import type { FlightSearch, StaySearch, FlightBooking, StayBooking, TripSearch } from './schemas.js';

export class Travel {
  private duffel: Duffel;
  private liteapi: LiteApi;
  private demo = new Demo();
  advisor: Advisor;
  constructor(public config: Config, http: HttpClient, fetcher?: typeof fetch) { this.duffel = new Duffel(config, http); this.liteapi = new LiteApi(config, http); this.advisor = new Advisor(config, fetcher); }
  get usesAdvisor() { return this.advisor.enabled && !this.isDemo; }
  private requireFlights() { if (!this.config.FLIGHTS_ENABLED) throw new ApiError(503, 'FLIGHTS_DISABLED', 'Flights are switched off. Set FLIGHTS_ENABLED=true to use them.'); }
  get isDemo() { return this.config.TRAVEL_MODE === 'demo'; }
  envelope(provider: string, data: unknown) { return { provider: this.isDemo ? 'demo' : provider, environment: this.isDemo ? 'demo' : provider === 'duffel' ? (this.duffel.live ? 'production' : 'sandbox') : (this.liteapi.sandbox ? 'sandbox' : 'production'), observed_at: new Date().toISOString(), data }; }
  async flights(input: FlightSearch) { this.requireFlights(); return this.envelope('duffel', await (this.isDemo ? this.demo.flightSearch(input) : this.duffel.searchFlights(input))); }
  async offer(id: string) { this.requireFlights(); return this.envelope('duffel', await (this.isDemo ? this.demo.offer(id) : this.duffel.getOffer(id))); }
  private async advisorStays(input: StaySearch) { return { ...this.envelope('advisor', await this.advisor.searchStays(input)), environment: 'live' }; }
  private async liteStays(input: StaySearch) { return this.envelope('liteapi', await (this.isDemo ? this.demo.staySearch(input) : this.liteapi.searchStays(input))); }
  // provider unset keeps the legacy choice (advisor when configured) for the built-in chat agent. 'auto' is what API callers get by default.
  async stays(input: StaySearch) {
    const provider = input.provider ?? (this.usesAdvisor ? 'advisor' : 'liteapi');
    if (provider === 'liteapi' || this.isDemo) return this.liteStays(input);
    if (provider === 'advisor') { if (!this.advisor.enabled) unavailable('the Expert Travel Advisor', 'ADVISOR_URL'); return this.advisorStays(input); }
    // auto: bookable LiteAPI inventory first, the advisor (pay at the property) when LiteAPI has nothing or is not configured.
    let lite: Awaited<ReturnType<Travel['liteStays']>> | undefined, failure: unknown;
    if (this.config.LITEAPI_API_KEY) { try { lite = await this.liteStays(input); } catch (error) { failure = error; } }
    const usable = (lite?.data as any)?.hotels?.some((h: any) => h.rooms?.length);
    if (usable || !this.advisor.enabled || input.hotel_ids?.length) { if (lite) return lite; throw failure ?? new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Set LITEAPI_API_KEY or ADVISOR_URL to search hotels.'); }
    return this.advisorStays(input);
  }
  async bookFlight(input: FlightBooking, id: string, submitted: () => Promise<void>) { this.requireFlights(); return this.envelope('duffel', await (this.isDemo ? this.demo.book('flight', input, id) : this.duffel.bookFlight(input, id, submitted))); }
  async hotel(id: string) { return this.envelope('liteapi', await (this.isDemo ? this.demo.hotelDetails(id) : this.liteapi.hotelDetails(id))); }
  async bookStay(input: StayBooking, id: string, submitted: () => Promise<void>) { return this.envelope('liteapi', await (this.isDemo ? this.demo.bookStay(input, id) : this.liteapi.bookStay(input, id, submitted))); }
  async stayBooking(id: string) { return this.envelope('liteapi', await (this.isDemo ? this.demo.booking(id) : this.liteapi.getStayBooking(id))); }
  async booking(id: string) { this.requireFlights(); return this.envelope('duffel', await (this.isDemo ? this.demo.booking(id) : this.duffel.getFlightBooking(id))); }
  async trip(input: TripSearch) {
    const requests = Object.entries(input).map(async ([kind, request]) => {
      try { return [kind, { status: 'ok', ...await (kind === 'flights' ? this.flights(request as FlightSearch) : this.stays({ provider: 'auto', ...(request as StaySearch) })) }] as const; }
      catch (error: any) { return [kind, { status: 'error', error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Search failed.' } }] as const; }
    });
    const parts = Object.fromEntries(await Promise.all(requests));
    const complete = Object.values(parts).every((part: any) => part.status === 'ok');
    return { mode: this.config.TRAVEL_MODE, complete, observed_at: new Date().toISOString(), summary: summarizeTrip(parts), results: parts };
  }
  capabilities() {
    return {
      mode: this.config.TRAVEL_MODE, live_bookings_allowed: this.config.LIVE_BOOKINGS_ALLOWED,
      flights: { provider: 'duffel', enabled: this.config.FLIGHTS_ENABLED, credentials_present: !!this.config.DUFFEL_ACCESS_TOKEN, search_implemented: this.config.FLIGHTS_ENABLED, booking_implemented: this.config.FLIGHTS_ENABLED, supplier_crypto_payment: false },
      stays: { provider: this.usesAdvisor ? 'expert-travel-advisor' : 'liteapi', credentials_present: this.usesAdvisor || !!this.config.LITEAPI_API_KEY, search_implemented: true, booking_implemented: true, supplier_crypto_payment: false },
      masumi: { mode: this.config.MASUMI_MODE === 'simulated' ? 'simulated' : (!!this.config.MASUMI_TOKEN && !!this.config.MASUMI_AGENT_IDENTIFIER ? 'live' : 'unconfigured'), network: 'Preprod', payment_source_type: 'Web3CardanoV2', credentials_present: !!this.config.MASUMI_TOKEN && !!this.config.MASUMI_AGENT_IDENTIFIER, price_atomic: this.config.MASUMI_PRICE_ATOMIC, token_unit: this.config.MASUMI_TOKEN_UNIT, purpose: 'payment for search work', onchain_verified: false },
    };
  }
}
