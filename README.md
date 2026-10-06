# Origin: an AI travel agent you can hire and pay on Cardano

**Origin searches flights and hotels, then books them.** A buyer agent pays into escrow, Origin runs live supplier searches, commits to its answer with a hash, and the buyer verifies the proof. The buyer can then book the flight or hotel it picked, inside a budget cap it set.

Built for the TOKEN2049 Origins hackathon, Cardano – Agentic Commerce track, on [Masumi](https://www.masumi.network) (MIP-003) and [Sokosumi](https://sokosumi.com).

- **Live demo:** https://origin-travel-agent.vercel.app/demo-ui
- **API docs:** https://origin-travel-agent.vercel.app/docs
- **Coworker runner:** https://origin-travel-agent.vercel.app/coworker

## What it does

```
Buyer agent ──pays──▶ Escrow ──locks funds──▶ Origin ──parallel search──▶ Duffel (flights)
     ▲                                          │                        LiteAPI (hotels)
     │                                          ▼
     └──── verifies result hash ◀──── shortlist + offer IDs + proof
     │
     └──── books chosen offer (Idempotency-Key, confirm, max_total) ──▶ supplier order
```

| | |
| --- | --- |
| **Search** | Flights (Duffel) and hotel room rates (LiteAPI) in one call: `POST /v1/trips/search` |
| **Book** | Flights through Duffel orders and hotels through LiteAPI prebook and book |
| **Pay** | Paid search through Masumi MIP-003 and MPS V2, with escrow before work starts |
| **Prove** | Input and result hashes are recorded so the buyer can recompute and check them |
| **Stay safe** | Every booking needs a budget cap, explicit confirmation and an idempotency key |

## Why it is built this way

- **Agents buy from agents.** The endpoints are plain JSON with an OpenAPI schema, so another agent can call them without a human.
- **Money is guarded.** A booking fails if the offer exceeds `max_total`. A repeated request with the same key returns the saved result instead of booking twice.
- **Honest labelling.** Every response carries `provider`, `environment` and `observed_at`. Demo data is marked `provider: demo`. Live mode never substitutes demo inventory.

## Talk to it (Sokosumi)

Create a task for the Expert Travel Agency coworker and write in plain words:

1. `Plan a trip to Cebu for 3 days from 9 October` → the best hotels, a day-by-day plan with things to do, and the cost. Flights are not searched for now.
2. `I like it, book the hotel` (a new task) → the only step that is charged in paid mode: payment is confirmed in escrow first, then the checkout opens. Plans, questions and refusals are free.

The agent assumes 1 traveller unless the message says otherwise (`Bangkok, 20 October, 4 days, 2 people`). To book under a name, add `under Maria Santos`. JSON trip requests still work. Flight booking is not available from chat yet. Cebu, Bangkok, Singapore, Bali and Manila have curated activities.

## Try it

**In the browser:** open `/demo-ui`, pick Singapore → Bangkok, click **Hire the agent**. The page steps through signed terms, locked funds, search, result hash and buyer verification.

**From a terminal:**

```sh
npm ci
npm run dev                      # API at http://127.0.0.1:3026, docs at /docs
npm run demo                     # no credentials needed; results are labelled simulated
npm run demo:buy                 # autonomous buyer agent doing the full flow
npm run smoke -- --book          # every route on the hosted API, including sandbox bookings
```

```sh
curl -s http://127.0.0.1:3026/v1/capabilities
curl -s http://127.0.0.1:3026/v1/flights/search \
  -H 'Content-Type: application/json' --data-binary @examples/flights.json
curl -s http://127.0.0.1:3026/v1/stays/search \
  -H 'Content-Type: application/json' --data-binary @examples/stays.json
```

Change the example dates when needed. For live suppliers, copy `.env.example` to `.env.local` and add credentials. A free LiteAPI sandbox key is available at https://dashboard.liteapi.travel. Do not put credentials in chat or Git.

## API

| Method | Route | Use |
| --- | --- | --- |
| POST | `/v1/trips/search` | Search flights and hotels in parallel |
| POST | `/v1/flights/search` | Get offers and passenger IDs |
| GET | `/v1/flights/offers/:id` | Refresh price and expiry |
| **POST** | **`/v1/flights/bookings`** | **Book a flight (Duffel)** |
| GET | `/v1/bookings/flight/:id` | Flight booking status |
| POST | `/v1/stays/search` | Hotel rates by city or coordinates, with board, cancellation terms and totals |
| GET | `/v1/stays/hotels/:id` | Photos, facilities, description, check-in rules, review highlights |
| **POST** | **`/v1/stays/bookings`** | **Prebook and book a hotel offer within `max_total`** |
| GET | `/v1/bookings/stay/:id` | Hotel booking status |
| GET | `/v1/operations/:id` | Inspect the booking journal |
| GET | `/demo`, `/demo-ui` | MIP-003 sample and buyer demo page |

Full schemas: `/docs` or [docs/openapi.json](docs/openapi.json). Set `API_KEY` before public use and send `Authorization: Bearer <key>`.

### Booking safety

Each booking request needs an `Idempotency-Key` header, `confirm: true`, and `max_total` with currency. Refresh the offer first, and use the passenger IDs from the flight offer.

The request is saved to SQLite before it goes to the supplier. A repeat with the same key and body returns the saved result. A changed body with the same key is rejected. After a timeout, inspect `/v1/operations/:id` and the supplier status route before retrying: a new key can create a second booking. The journal does not prove a supplier creates an order exactly once.

Flights (Duffel) are switched off unless `FLIGHTS_ENABLED=true`; the chat agent never searches flights. `LIVE_BOOKINGS_ALLOWED=false` blocks production Duffel bookings. A live LiteAPI key needs `LIVE_BOOKINGS_ALLOWED=true`.

## Status

| Capability | Provider | Evidence |
| --- | --- | --- |
| Flight search and offer refresh | Duffel | Verified with the supplier test API |
| Flight booking | Duffel | Verified test order and duplicate request replay |
| Hotel search with room rates | LiteAPI (Nuitee) | Verified against the supplier sandbox |
| Hotel booking | LiteAPI | Verified with a sandbox booking, budget cap and idempotent replay |
| Buyer demo, buyer agent, smoke test | This repo | `/demo-ui`, `npm run demo:buy`, `npm run smoke` |
| Sokosumi coworker | Sokosumi | Execution rehearsals complete; event approval pending |
| Paid search on Cardano | Masumi MIP-003, MPS V2 | Protocol tests pass; registration pending, so no on-chain receipt yet |

**Limits.** Supplier data comes from sandbox inventory. It does not prove production airline pricing, ticket issuance or hotel availability. Until Masumi registration confirms, settlement is simulated and labelled as such. No production booking or crypto transfer was made.

## Stack

Node.js 24+, TypeScript, Fastify, SQLite booking journal, Neon PostgreSQL in the hosted deployment, Vercel hosting.

## Verify

```sh
npm run check && npm test && npm run build
npm run openapi
npm run verify:live                # supplier checks, saved privately to .data/verification.json
npm run verify:live -- --book-test # creates a Duffel test order; refuses a live token
```

## More

- [Demo runbook](docs/demo.md)
- [Deployment and Masumi registration](docs/deployment.md)
- [Sokosumi worker and judge access](docs/sokosumi.md)
- [Masumi setup](docs/masumi.md)
- [Feasibility and crypto payments](docs/feasibility.md)
- [Submission readiness](docs/submission-readiness.md)
