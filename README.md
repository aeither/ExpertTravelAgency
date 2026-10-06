# Origin travel API

Sokosumi execution rehearsals work through the dedicated Coworker worker. See [worker setup and judge access](docs/sokosumi.md) and [submission readiness](docs/submission-readiness.md). Event approval and paid seller-receipt proof remain outstanding.

Hosted API: https://origin-travel-agent.vercel.app — public docs and search, with Neon PostgreSQL storage. See [deployment and managed Masumi registration](docs/deployment.md). Paid Masumi registration is pending.

API endpoints for flight and hotel search, with flight booking routes. The AI agent can call these endpoints later. The server uses Node.js 24 or later, TypeScript, and Fastify.

## Current state

| Capability | Provider | Evidence |
| --- | --- | --- |
| Flight search and offer refresh | Duffel | Verified with the supplier test API |
| Flight booking | Duffel | Verified test order and duplicate request replay |
| Hotel search with room rates | LiteAPI (Nuitee) | Verified against the supplier sandbox; needs `LITEAPI_API_KEY` |
| Hotel booking | LiteAPI | Verified with a sandbox booking, budget cap, and idempotent replay |
| Buyer demo page, buyer agent, smoke test | This repo | `/demo-ui`, `npm run demo:buy`, `npm run smoke`; see [the demo runbook](docs/demo.md) |
| Paid search on Cardano | Masumi MIP-003 and MPS V2 | Local protocol tests pass; node configuration and on-chain receipt unverified |

Flight test offers use sandbox inventory. They do not prove production airline pricing or ticket issuance. LiteAPI sandbox hotel rates do not prove production availability. Demo mode returns synthetic data with `provider: demo` and `environment: demo`.

Private supplier credentials are in `.env.local` and `.data/`. Git ignores both locations. The Duffel test account uses the supplied project details and Italy. No production booking or crypto transfer was made.

## Run

```sh
npm ci
npm run dev
```

The API listens at `http://127.0.0.1:3026`. Open `http://127.0.0.1:3026/docs` for request schemas and interactive calls. The schema is also in [docs/openapi.json](docs/openapi.json).

For a new checkout, copy `.env.example` to `.env.local` and add supplier credentials. Get a free LiteAPI sandbox key from https://dashboard.liteapi.travel. Do not put credentials in chat or Git.

```sh
curl -s http://127.0.0.1:3026/v1/capabilities
curl -s http://127.0.0.1:3026/v1/flights/search \
  -H 'Content-Type: application/json' --data-binary @examples/flights.json
curl -s http://127.0.0.1:3026/v1/stays/search \
  -H 'Content-Type: application/json' --data-binary @examples/stays.json
```

Change the example dates when needed.

Set `API_KEY` before public use and send `Authorization: Bearer <key>`. A public `HOST` requires an API key of at least 24 characters. The default host is local.

## Routes

| Method | Route | Use |
| --- | --- | --- |
| POST | `/v1/flights/search` | Get offers and passenger IDs |
| GET | `/v1/flights/offers/:id` | Refresh price and expiry |
| POST | `/v1/flights/bookings` | Create an order using the Duffel balance |
| POST | `/v1/stays/search` | Search hotels by city or coordinates; returns room rates, board, cancellation terms, and totals |
| GET | `/v1/stays/hotels/:id` | Hotel photos, facilities, description, check-in rules, and review highlights |
| POST | `/v1/stays/bookings` | Prebook and book a hotel `offer_id` within `max_total` (sandbox) |
| GET | `/v1/bookings/stay/:id` | Get hotel booking status |
| GET | `/demo` | MIP-003 sample input and output |
| GET | `/demo-ui` | Buyer demo page: pay, search, verify |
| POST | `/v1/demo/simulate-payment` | Rehearsal only: fund the simulated escrow |
| POST | `/v1/trips/search` | Search flights and hotels in parallel |
| GET | `/v1/bookings/flight/:id` | Get flight booking status |
| GET | `/v1/operations/:id` | Inspect the local booking journal |

Supplier response bodies remain in `data`; the API adds `provider`, `environment`, and `observed_at`.

## Booking

Every booking request needs an `Idempotency-Key` header, `confirm: true`, and a `max_total` amount and currency. Refresh the selected offer or quote first. Use the passenger IDs from the flight offer. The OpenAPI schema contains each required field.

A booking is saved to SQLite before supplier submission. A successful repeated request with the same key and body returns the saved result. A changed body with the same key is rejected. An uncertain request requires inspection through `/v1/operations/:id` and the supplier status route. Creating a new key after a timeout can create a second booking. The journal does not prove that a supplier creates an order exactly once.

`LIVE_BOOKINGS_ALLOWED=false` blocks production Duffel bookings. Test Duffel orders remain available. Hotel bookings use the LiteAPI sandbox key; a live key needs `LIVE_BOOKINGS_ALLOWED=true`.

## Verification

```sh
npm run check
npm test
npm run build
npm run openapi
npm run verify:live
npm run verify:live -- --book-test
```

The last command creates a Duffel test order with synthetic passenger details. It refuses a live token. The supplier verification script saves a private record in `.data/verification.json`. It never creates a real hotel booking or pays crypto.

For a demo without credentials, use `npm run demo`. Search results and bookings are explicitly simulated. Live mode returns configuration errors when a supplier is unavailable and does not substitute demo inventory.

See [feasibility and crypto payments](docs/feasibility.md) and [Masumi setup](docs/masumi.md) for the remaining access and payment steps.
