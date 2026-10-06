# Hosted Origin API

The API runs on Vercel with Neon PostgreSQL. Public docs and travel search require no bearer token. Supplier booking and administrative routes remain protected; production bookings are disabled.

API URL: https://origin-travel-agent.vercel.app

Vercel project: https://vercel.com/giovannis-projects-e21f471c/origin-travel-agent

Neon database: `origin-travel-agent-db`, free plan, Singapore region. Neon stores payment jobs, booking idempotency records, and Masumi job state. The deployed handler refuses to start without `DATABASE_URL_UNPOOLED`; it never falls back to local SQLite. Local development and existing tests can still use SQLite.

`PUBLIC_SEARCH=true` opens `/`, `/docs`, `/openapi.json`, capability discovery, and search routes. `/` redirects to interactive API docs. MIP-003 discovery, `/start_job`, and `/status` are also public. Paid work requires confirmed funds.

Vercel Hobby limits cron to daily runs. The serverless deployment disables the local polling timer. Buyer requests to `/status` advance the requested job under a PostgreSQL advisory lock, so the buyer must keep polling until completion. No paid cron upgrade or always-running server is required. The direct Neon connection is used because session locks are incompatible with transaction pooling.

Duffel uses test credentials for flights. Hotel search uses the LiteAPI sandbox (`LITEAPI_API_KEY`, a `sand_` key). Neither proves production inventory. Hotel booking uses the LiteAPI sandbox. Travala, Viator, and Duffel Stays were removed because they needed credentials or approvals that were not available.

## Settlement mode

Production currently runs `MASUMI_MODE=simulated`. `/demo-ui` and `npm run demo:buy` run the full paid flow with simulated escrow, labelled as such everywhere; `/availability` reports `unavailable` so no real buyer is told the agent is payable. Remove the variable and redeploy once Masumi registration confirms.

## Masumi managed service

[Masumi as a Service](https://www.masumi.network/dev/masumi/documentation/get-started/masumi-as-a-service) hosts payment and registry infrastructure. It does not deploy this application. No local Masumi node is required for the managed path.

The supplied platform API key was verified against the authenticated dashboard and the Preprod payment-source proxy. It is stored in `.data/masumi-platform-key`, outside Git, separately from the Origin API bearer token.

Use `MASUMI_URL=https://app.masumi.network/pay/api/v1`. The implementation sends bearer authentication for this managed host, while retaining the `token` header for self-hosted nodes. Configure `MASUMI_TOKEN` and `MASUMI_AGENT_IDENTIFIER` only after confirmed registration.

Preprod registration was submitted for **Origin Travel Search** (platform ID `dadcc8f0-8f91-48e8-b9f0-b420ad73199b`) at 2026-10-06 09:56 UTC. Pricing is Dynamic; the registered API URL is https://origin-travel-agent.vercel.app. At last inspection the state was `RegistrationRequested`, with no on-chain identifier yet. Identity verification and on-chain seller receipt remain unverified.

## Deploy changes

Run `npm run check`, `npm test`, and `npm run build`, then `vercel deploy --prod --yes`. Verify the production URL, `/health`, public docs, and supplier search. Secrets and local data are excluded from upload.

The downloaded Masumi index is in `.agents/skills/masumi/SKILL.md`.

Verification on 2026-10-06: 15 local tests passed. Live Vercel search returned Duffel sandbox flight offers and LiteAPI sandbox hotels with room rates, without a bearer token; `/v1/trips/search` returned `complete: true`. Neon verification covered concurrent operation claims, persisted results, job locks, and status-driven payment processing across app restarts with mocked payment APIs. No on-chain payment was tested. The earlier Railway API deployment was stopped after Vercel verification; its volume is retained.

## Preprod test wallet

A dedicated payout wallet was generated with Cardano CIP-1852 account zero. Its address is `addr_test1qr5p49rdtsa7eux0s2zttxthdr6xmz7p95xp8rjast4sqk8n0gwz9kqz4u6glag5l7yqum7348grjt50uyte2vf4eqhq64ys6r`. Recovery material is in `.data/masumi-preprod-wallet.json` (mode 0600, ignored by Git). Back it up privately; never publish it or put it in a Vercel environment variable. Wallet recovery was validated against the saved root key. This wallet is intended for testnet only.

The [faucet transaction](https://preprod.cexplorer.io/tx/ce6399856e27927503ebcaeff99b533cb955c1d94a139c21e2d0f854c83c8d36) is visible on-chain and sends 100 test ADA plus test USDM to this address. The separate 5 ADA collateral also arrived; the observed wallet balance is 105 test ADA. This is the payout/test wallet; the managed SaaS creates and controls a separate selling/registry wallet. Funding this payout wallet does not prove the managed selling wallet is funded.

Run `npx tsx scripts/connect-masumi.ts` to check completion and, only when `RegistrationConfirmed`, save the on-chain identifier and platform token privately in `.env.local` and Vercel production settings. Then redeploy Vercel and verify `/availability` and the authenticated `/v1/masumi/health`. Until confirmation, paid jobs remain unavailable.

Last registration check: 2026-10-06 10:06 UTC. Masumi still reports `RegistrationRequested` and `verificationStatus=PENDING`; no agent identifier has been returned. The completion route returns HTTP 202/pending, and the separate on-chain verification route returned HTTP 504. Paid jobs have not been enabled. No duplicate registration was submitted.
