# AI agent for the Sokosumi coworker, run on Railway

Date: 2026-10-07. Status: draft for review.

## Goal

Replace the regex planner (`src/planner.ts`: `parseMessage`, canned itinerary) with a tool-calling AI agent, so the Sokosumi coworker understands free-form requests and writes its own plans. Keep what already works: the Sokosumi task loop, the Masumi paid flow, the hotel-agent client. Run everything always-on on Railway, then make sure registration and environment settings match that host, and prove it with a full regression run.

Success: (1) a free-form plan request is answered for free by the agent, (2) "book the hotel" is charged once and returns a real checkout link, (3) nothing regresses against the current behaviour, (4) the registry entry and every environment variable point at the Railway deployment.

## Decisions already made

- **Library:** Vercel AI SDK (`ai`), not Eve. Eve is in public beta, owns its own project layout and HTTP server, and self-hosting needs extra storage and a sandbox. The Masumi demo's Eve agent is a text-only helper beside a hand-written worker; our worker already exists. Revisit Eve after GA.
- **Model provider:** OpenRouter through `@openrouter/ai-sdk-provider`. Default is a fixed free model; `openrouter/free` is selectable by setting. Free models vary in tool-calling quality and are rate limited.
- **Host:** Railway service `origin-api` (always on, runs the poller and payments). Vercel keeps serving docs and the demo UI only.

## Architecture

```
Sokosumi task -> poller (Railway, src/sokosumi.ts, unchanged state machine)
                   |-- decide: does this turn need payment?   (agent output, not regex)
                   |-- PaidFlow (unchanged): quote -> escrow -> result hash -> collection
                   `-- agent turn: src/agent.ts (new) -> tools -> hotel agent / store
```

### Agent (`src/agent.ts`, new)

`runAgent({ text, history, phase, owner })` returns `{ kind: 'answer' | 'ask' | 'book', text }`.

Tools (zod schemas, all server-side code):
- `search_hotels(destination, check_in, check_out, adults)`: existing `Travel.stays`, both lodging filters.
- `get_saved_plan` / `save_plan`: per-owner plan in the existing store (replaces the `latest-plan:<owner>` entry).
- `ask_user(question)`: ends the turn; the poller posts `INPUT_REQUIRED`, and the user's reply is passed back as history.
- `request_booking()`: ends the turn with `kind: 'book'`. It only declares intent.
- `prepare_checkout()`: runs the existing `openCheckout` (top pick, then fallbacks) and stores the link server-side. It never returns the link.
- `reveal_checkout()`: available **only** in the paid phase (escrow confirmed). Returns the link.

### Payment gate (code, not model)

Phase 1 (free): the agent may search, plan, ask, and call `request_booking` and `prepare_checkout`. If it ends with `book` and a checkout is prepared, the poller starts `PaidFlow`. The model has no tool that charges.
Phase 2 (after confirmed escrow): a second turn with `reveal_checkout` added writes the final answer. If phase 1 could not prepare any checkout, no charge is made.

This keeps today's guarantees: plans are free, booking is the only charge, no link before payment, no charge when nothing can be opened.

### Fallback

If OpenRouter errors, times out, or returns no usable answer after one retry, run the existing deterministic planner path unchanged. `planner.ts` stays in the repo as that fallback; the fallback is logged and tagged in the task summary.

### State

Conversation history (messages and tool results, trimmed) is saved in the existing per-task journal state, so INPUT_REQUIRED replies and crash recovery work like today. Saved state keeps the `charged` flag semantics already in place.

## Configuration and registration (Railway)

1. **Audit first (read-only):** query the Railway payment node (`mps`) for the registered agent (`MASUMI_AGENT_IDENTIFIER` starting `67ab0c92`): state, `apiBaseUrl`, pricing. Check that `GET /availability` and `/input_schema` on the Railway URL respond.
2. **Registry:** if the registered `apiBaseUrl` is not `https://origin-api-production-d268.up.railway.app`, update it on the node if the node allows. Register a new agent only if updating is impossible; that creates a new agent ID, which then goes into `MASUMI_AGENT_IDENTIFIER`. No duplicate registration is submitted without confirming the old one is unusable.
3. **Sokosumi:** the coworker is pull-based (ID plus runtime key, no callback URL), so nothing is re-registered there unless the audit shows the listing references a stale URL. Check the Vendor grant and credits.
4. **Environment (Railway `origin-api`):** add `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`; confirm `ADVISOR_URL`, `SOKOSUMI_PAID`, `SOKOSUMI_POLL`, `MASUMI_*` are correct. Vercel keeps its current values and does not poll.
5. **Single runner:** only Railway polls. The `/coworker` runner page on Vercel is disabled or left unused so two runners cannot take the same task.

I need an OpenRouter API key from you for step 4.

## Testing and regression

- Unit tests with a mocked language model (`MockLanguageModel`): plan, ask, book, fallback on model failure, and "no reveal tool before payment".
- Keep all current tests green (50 today); the planner and payment tests stay.
- One live OpenRouter run against the hotel agent before deployment.
- Full flow on Railway after deploy, with real Sokosumi tasks: (a) free plan task, no payment comment; (b) a vague request that makes the agent ask a question and continue after a reply; (c) "Book the hotel" new task: payment requested, escrow confirmed, checkout link delivered, collection comment later; (d) a booking request with no plan: no charge.
- Compare behaviour against the current planner for the Manila 18-20 Oct prompts used so far.

## Out of scope

Flights, cancellations, Eve migration, changing prices or the payment amount, any new payment mechanism.

## Risks

- Free models may call tools badly or hit rate limits: mitigated by the fixed default, one retry, and the deterministic fallback.
- Re-registration may require test ADA and a new agent ID; handled in step 2.
- An agent can ignore its prompt: the payment gate is enforced in code, so the worst case is a wrong answer, never a charge or a free link.
