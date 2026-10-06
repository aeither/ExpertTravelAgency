# AI agent, Railway hosting and Masumi registration

Updated 2026-10-07. No secrets in this file; keys live in `.env.local` (git-ignored) and in Railway variables.

## How a Sokosumi task is handled

`src/sokosumi.ts` polls Sokosumi (Railway `origin-api`, `SOKOSUMI_POLL=true`). For each task it runs the AI agent in `src/agent.ts` (Vercel AI SDK + OpenRouter, model `openrouter/free`).

- **Plan:** the agent searches hotels (`search_hotels`), saves the plan (`save_plan`) and shares it as an `INPUT_REQUIRED` question: reply "book" to continue in the same task, or "no" to finish. Free, no payment until "book".
- **Missing detail:** the agent calls `ask_user`; the task goes to `INPUT_REQUIRED` and the traveller's reply continues it.
- **"book" (reply on the plan task, or a new "Book the hotel" task):** the agent calls `request_booking`. Code opens the hotel checkout first (top pick, then fallbacks), and only if one opens does the Masumi paid flow start (escrow, result hash, collection). The checkout link is handed over by code after escrow is confirmed. The model has no tool that charges and never sees the link.
- **Model failure:** the deterministic planner (`src/planner.ts`) answers instead.

## Where things run

| What | Where |
|---|---|
| Poller, agent, payments (always on) | Railway service `origin-api`, https://origin-api-production-d268.up.railway.app |
| Payment node (MPS) | Railway service `mps`, https://mps-production-0546.up.railway.app |
| Docs and demo UI only | Vercel, https://origin-travel-agent.vercel.app |

Deploy both after a change: `git push`, `railway up --service origin-api --detach`, `vercel deploy --prod --yes`.

## Masumi registration

Registered on the Railway payment node (not the managed SaaS): agent **Expert Travel Agency**, type Standard, Dynamic pricing, selling wallet funded with test ADA. The earlier "Origin Travel Search" entry on the managed service stayed `RegistrationRequested`; the working path follows the Masumi demo template: register through the node's own `/registry` with a funded selling wallet, `{"pricingType":"Dynamic"}`, and an `apiBaseUrl` that serves `/availability`, `/input_schema`, `/start_job`, `/status`.

On 2026-10-07 the registration was updated (`POST /registry/update`) so `apiBaseUrl` points at the Railway URL. An update burns and mints the registry NFT, so the **agent identifier changed** (last segment `…000000` to `…000001`); `MASUMI_AGENT_IDENTIFIER` was updated in Railway and `.env.local`. Details: `.data/masumi-railway-registration.json` (git-ignored). Sokosumi needs no re-registration: the coworker polls with its ID and key and has no callback URL.

## Environment

Railway `origin-api`: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=openrouter/free`, `ADVISOR_URL`, `SOKOSUMI_PAID=true`, `SOKOSUMI_POLL=true`, `SOKOSUMI_COWORKER_ID/API_KEY`, `MASUMI_URL` (private network), `MASUMI_AGENT_IDENTIFIER`, `MASUMI_TOKEN`.
Names only are in `.env.example`.

## Regression run (2026-10-07, real Sokosumi tasks on Railway)

1. Plan request: answered by the agent, no payment event.
2. "Book the hotel": payment requested, escrow and result hash confirmed on-chain, checkout link delivered after payment, fallback hotel opened when the top pick could not open a checkout. Repeated with the new agent identifier.
3. Vague request: the agent asks for the missing date.
4. 61 automated tests pass (`npm test`); `scripts/live-agent.ts` runs the agent live against OpenRouter and the hotel agent.
