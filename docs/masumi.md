# Masumi paid search

This backend implements the MIP-003 HTTP contract without an AI model. Its paid job runs structured travel search. The current integration targets Masumi Payment Service V2 on Cardano Preprod.

| Method | Route | Use |
| --- | --- | --- |
| GET | `/availability` | Check whether paid search is configured |
| GET | `/input_schema` | Get the paid search input schema |
| POST | `/start_job` | Create signed payment terms and a saved job |
| GET | `/status?job_id=...` | Get payment and search state |
| GET | `/v1/masumi/health` | Check the configured payment service |

The single user input is `trip_request_json`, a string containing the same JSON used by `/v1/trips/search`. The MIP-003 input hash uses the exact nonce and serialized one-field object. The result hash uses the exact persisted result string. The tests verify both hashes and payment state transitions.

The job waits for confirmed `FundsLocked` before it calls suppliers. It then persists the result and submits its hash to MPS. Confirmation of result submission permits job completion. Seller receipt is a separate check; the response keeps `seller_receipt_verified: false`. Uncertain external writes are not resubmitted automatically.

## Configure the payment node

For hosted operation, use Masumi as a Service rather than running a local node. See [deployment](deployment.md) for the live API, managed proxy URL, and pending registration requirements. The self-hosted instructions below remain an alternative.

Follow the [TOKEN2049 quickstart](https://www.masumi.network/token2049) and its [agent setup guide](https://www.masumi.network/token2049/agent-guide.md). Use the current [Masumi Payment Service](https://github.com/masumi-network/masumi-payment-service) with a dedicated PostgreSQL database, a Cardano Preprod Blockfrost key, and an encryption key kept outside Git.

The workshop guide uses port `3012`. Build the service, apply its database migrations, then seed the Preprod database once with seed output suppressed. Wallet seed output must stay out of terminal transcripts. Preserve the database and encryption key when you resume. The guide specifies `AUTO_WITHDRAW_PAYMENTS=true` and a V2 Preprod payment source.

Fund the actual wallets with test ADA and test USDM as required by the guide. Use the [Masumi dispenser](https://dispenser.masumi.network/). Check balances before registration. Do not use a wallet address copied from an example.

Register the backend URL with Dynamic pricing and Cardano Preprod. Save the registration identifier and a scoped payment token privately in `.env.local`:

```dotenv
MASUMI_URL=http://127.0.0.1:3012/api/v1
MASUMI_TOKEN=<scoped payment token>
MASUMI_AGENT_IDENTIFIER=<confirmed registration identifier>
MASUMI_SUPPORTED_SOURCE_INDEX=0
MASUMI_PRICE_ATOMIC=1000000
MASUMI_TOKEN_UNIT=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d
```

The price is 1 test USDM, expressed in atomic units. It pays for search work. It is not the travel booking price. Verify the payment source index against your running node instead of assuming index zero.

Restart the API after configuration. Check `/v1/masumi/health`, `/availability`, and `/input_schema`. Create one paid job, fund it using the signed terms, then poll `/status`.

Record the payment identifier, exact result hash, signed deadlines, collection transaction hash, seller address, and independent seller receipt before claiming that the paid test passed. Registration, locked funds, and task completion each prove a different step.

## Try the live agent

Open https://origin-travel-agent.vercel.app/docs, expand `POST /v1/flights/search`, click **Try it out**, paste this body, and click **Execute**. Public search requires no bearer token.

```json
{"slices":[{"origin":"SIN","destination":"BKK","departure_date":"2026-11-10"}],"passengers":[{"type":"adult"}]}
```

These are Duffel sandbox flight offers. For hotels, use `POST /v1/stays/search` with:

```json
{"check_in_date":"2026-12-01","check_out_date":"2026-12-03","rooms":[{"adults":2}],"location":{"city":"Singapore","country_code":"SG"}}
```

## Finish the existing registration

The API is live on Vercel with Neon storage. Masumi's managed API accepts our credentials. Our Preprod payout wallet received test ADA and test USDM. Registration was submitted for Origin Travel Search, platform ID `dadcc8f0-8f91-48e8-b9f0-b420ad73199b`. The latest check on 2026-10-06 still reports `RegistrationRequested`, verification `PENDING`, and no on-chain agent identifier. A paid on-chain job and seller receipt have not yet been verified.

Inspect https://app.masumi.network/ai-agents on **Preprod**. Avoid creating a duplicate registration. Run `npx tsx scripts/connect-masumi.ts` to retry completion of the existing request. Pending state exits with code 2. Once Masumi confirms registration and returns the identifier, the script configures private local and Vercel Masumi settings. Then run `vercel deploy --prod --yes` and verify `/availability`.

The completion endpoint returns a generic pending response mentioning an unfunded wallet. Masumi uses its own registration funding and selling wallets; funding our payout address does not prove those internal wallets are funded. The response alone does not identify the delay's cause. If it remains stuck, give Masumi support the platform ID above and request investigation of registration funding/minting and registry synchronization.

After activation, paid testing follows `/input_schema` → `/start_job` → fund the returned signed payment terms on Preprod → poll `/status?job_id=...` until completion. Creating a job alone does not pay for it. On Vercel, status polling also advances the job.
