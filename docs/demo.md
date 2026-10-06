# Demo runbook

Story: a buyer hires an AI agent for a paid trip search. The buyer pays into escrow, the agent runs live flight and hotel searches, commits to its answer with a hash, and the buyer verifies the proof.

## Before you go on stage

```sh
npm run smoke -- --book     # every route on the hosted API, incl. Duffel and LiteAPI sandbox bookings
```

Expect all green. `GET /availability` shows BLOCKED while settlement is simulated; that is intentional. Check the settlement badge at https://origin-travel-agent.vercel.app/demo-ui. Keep the page open in a tab and run the flow once to warm the servers.

## The 3-minute script

1. Open `/demo-ui`. Say what the badge says. Rehearsal mode: "no real funds move, every proof is labelled simulated."
2. Pick Singapore → Bangkok, click **Hire the agent**. Narrate the steps as they tick: signed terms bound to the request, funds locked, search runs only after funds lock, result hash recorded, buyer recomputes both hashes.
3. Show the delivered trip: cheapest and fastest flight, top-rated hotels, estimated total.
4. Terminal version for developers: `npm run demo:buy`. Same flow as an autonomous buyer agent.
5. Optional: in `/docs`, book the chosen hotel (`POST /v1/stays/bookings`) with a budget cap, then show the over-budget refusal.

## Switching to real Cardano settlement

Rehearsal mode (`MASUMI_MODE=simulated`) exists because on-chain settlement was not available when this was built:

- The Masumi registration for "Origin Travel Search" was stuck at `RegistrationRequested`, identity verification pending, no agent identifier.
- The managed payment source showed no purchasing wallet, so no buyer could pay.

When registration confirms: run `npx tsx scripts/connect-masumi.ts` (writes `MASUMI_URL`, `MASUMI_TOKEN`, `MASUMI_AGENT_IDENTIFIER` to Vercel), remove `MASUMI_MODE` (or set it to `live`), redeploy, then run `npm run demo:buy` with `BUYER_PAYMENT_URL` and `BUYER_PAYMENT_TOKEN` pointing at a Payment Service that has a funded purchasing wallet. The `/purchase` request in `scripts/demo-buy.ts` follows the Payment Service schema but has not been run against a real node.

## What you may and may not claim

- Say: flights and hotels are live supplier sandbox searches; bookings are sandbox bookings; hashes are really computed and verified in the browser.
- Do not say: payments are on-chain, or real tickets or rooms were booked, while the badge reads "simulated". Cardano settlement is only proven when Cardanoscan shows the transactions.
