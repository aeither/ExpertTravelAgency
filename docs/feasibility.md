# Travel API feasibility

Checked on 6 October 2026 against official supplier documentation and the live LiteAPI sandbox.

## Level 1: search

Flight and hotel search use supplier APIs that issue credentials without a sales or approval step. This project has verified Duffel flight search in test mode and LiteAPI hotel search against the supplier sandbox.

Duffel offers flight search, pricing, and booking in one API. The test account is ready. Production inventory requires live account setup and funds. Sources: [Duffel quick start](https://duffel.com/docs/guides/getting-started-with-flights).

LiteAPI (Nuitee Connect) offers hotel search, rates, and booking over REST. A free account issues a `sand_` sandbox key immediately with no card. Search returns hotel details, room rates, board type, taxes, and cancellation terms for 2M+ properties. Production access needs a live key. Sources: [LiteAPI docs](https://docs.liteapi.travel/reference/overview).

Not used, and why:

- Travala: removed because it is a competitor. Its hotel search needed an OAuth grant tied to one person's account.
- Viator: partner API keys need an approved partner account, which was not available.
- Duffel Stays: needs access approval. The test token returned HTTP 403.
- Amadeus Self-Service: the portal was decommissioned on 17 July 2026. Access now goes through an enterprise sales process.

## Level 2: booking

Duffel flight booking was verified with a test order. The backend refreshes the offer, checks the total against the request's budget, then creates an instant order using the Duffel balance. The test does not prove a production ticket. Production needs supplier activation and a funded balance. Source: [Duffel orders API](https://duffel.com/docs/api/orders).

Hotel booking uses LiteAPI's prebook then book flow with the `offer_id` from `/v1/stays/search`. The backend prebooks to get the real price, refuses anything over `max_total`, journals the request, then books against the account balance. Sandbox bookings return `CONFIRMED` with a test confirmation code; they do not reserve a real room.

## Crypto payment

| Path | Asset and network | Available scope |
| --- | --- | --- |
| Masumi paid search | Test USDM on Cardano Preprod | Payment for the travel search work; local integration implemented, chain test pending |
| Duffel supplier booking | Supplier account settlement | No native ADA payment found in the referenced API documentation |

An ADA payment to your agent does not automatically pay an airline or hotel supplier. You need a separate supplier settlement method. The current Duffel implementation uses the supplier balance. A conversion or treasury service would need its own implementation and reconciliation.

For the hackathon, a test flight order plus a verified Masumi paid search is a feasible first demonstration. A claim of a Cardano-paid real trip needs evidence of both the Cardano payment and the supplier reservation.
