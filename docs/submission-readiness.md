# TOKEN2049 submission readiness

Current assessment: **not ready for final submission**. Execution rehearsals work; paid task integration, seller receipt, event approval, repository access, and the final presentation remain outstanding. Hosting uses Vercel with browser-triggered task checks.

Sources: [official checklist](https://www.masumi.network/token2049/submission), [integration brief](https://www.masumi.network/token2049/agent), [BuilderBase overview](https://builderbase.com/track-dashboard/token2049-origins-hackathon/overview).

| Requirement | Evidence | Remaining work |
| --- | --- | --- |
| Team and track | Bebop / Cardano – Agentic Commerce visible in BuilderBase | Verify final submission form and deadline |
| Hosted project | https://origin-travel-agent.vercel.app/demo-ui, `/docs`, and `/coworker` | Keep the runner page open for task pickup; no continuous background poller |
| Code and instructions | Vercel task runner, optional local worker, `docs/sokosumi.md` | No commits or remote yet; publish reviewed code or grant judge access |
| Coworker | `01a11100-48ed-74a7-b050-f616bc9751d6` | Event request PENDING |
| Completed task | `01a11103-ed45-7068-b0c6-2ffc923a8fd7` | Add separate paid task; current task is rehearsal only |
| Payment | Masumi registration PENDING | Confirm registration and implement/test paid task bridge |
| Seller receipt | None verified | Collection hash, explorer link, seller address, token unit, independent net receipt measurement |
| Presentation | No file yet | `.ppt` or `.keynote`, hosted in Google Drive |
| Demo recording | No final paid recording | Record verified paid path and embed video directly in slides |
| Availability | Not promised | State a date backed by hosted services |

## Verified execution

Origin turns structured travel requests into deterministic supplier-backed shortlists. It uses sandbox inventory; no language-model turn or natural-language assistant has been tested. The automatic task compared 48 flight offers and five hotels, preserved different currencies, and returned source documentation and offer IDs. Completion event: `01a11104-12cc-754c-9c88-5c08ceb76283`. A restart added no events. All 30 tests, type checks, application build, and worker build passed.

The production Vercel handler completed task `01a1110c-774e-70cd-ad10-b3f53c36cce8`. Concurrent requests returned completed and busy, confirming that the second request did not execute the same task. The hosted runner page was tested and left paused. The runner executes within Vercel and stores progress in Neon; it does not require a local worker. A literal laptop-offline test was not performed. Open the runner page and enable checks for subsequent tasks.

## Payment blocker

Existing Masumi platform registration: `dadcc8f0-8f91-48e8-b9f0-b420ad73199b`. Latest retry: RegistrationRequested, verification PENDING, no confirmed agent identifier. Preserve this registration and wallet. Give this ID to the Masumi team for investigation; no support message was sent automatically.

The hosted API uses labelled simulated settlement. Simulated results and wallet faucet funding do not prove seller collection. The execution worker has no paid task bridge. Verify deployed Core/MPS signed-term compatibility before implementing quote → payment event → confirmed escrow → work → result hash → completion → collection. Do not edit signed fields.

## Final demo

Show the buyer and exact input, hosted task pickup, fresh 1 test USDM quote, confirmed escrow before work, supplier answer and result hash submission, task completion, and independent seller collection. Show restart recovery and laptop-offline execution. Record the paid sequence only after it passes. Embed the recording directly in the submitted slides; the brief does not accept a live stage demo or external video link as a substitute.

Before publishing, inspect all included files for secrets, personal identifiers, local paths, and private access links. Exclude `.data/`, `.env.local`, wallet recovery material, OAuth URLs, and deployment credentials. Check the official deadline in BuilderBase; no exact deadline has been recorded here.
