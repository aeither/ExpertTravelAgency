# Sokosumi task worker

Origin Travel Search turns structured trip requests into a supplier-backed shortlist for travel operations teams. It uses deterministic ranking and Duffel/LiteAPI sandbox inventory. Natural-language requests and language-model turns are not implemented.

References: [event guide](https://www.masumi.network/token2049), [full brief](https://www.masumi.network/token2049/agent), [Coworker API](https://www.masumi.network/dev/sokosumi/documentation/coworkers).

## Verified on 2026-10-06

| Checkpoint | Evidence |
| --- | --- |
| CLI | 1.0.4; authenticated on Preprod |
| Vendor | Bebop: `01a11100-22ad-74ca-8076-05a63cbabe04` |
| Coworker | Origin Travel Search: `01a11100-48ed-74a7-b050-f616bc9751d6` |
| Personal access | GRANTED; runtime key verified; 3,250 credits observed |
| Manual task | `01a11100-efbc-739e-93c5-77db89bb8ca5`: COMPLETED |
| Automatic task | `01a11103-ed45-7068-b0c6-2ffc923a8fd7`: COMPLETED |
| Vercel task | `01a1110c-774e-70cd-ad10-b3f53c36cce8`: COMPLETED |
| Concurrent Vercel requests | One completed, one busy; no duplicate execution |
| Restart | No additional task events |
| Event access | Request `01a11102-cef3-77b3-9033-347bd59143bb`: PENDING |
| Event eligibility | `taskSeatEligible: true` |

Manual completion event: `01a11103-7986-71bb-af59-62bfbf87fabf`. Automatic completion event: `01a11104-12cc-754c-9c88-5c08ceb76283`. These tasks prove execution only. Exact answers and private evidence are in ignored `.data/`.

## Run

Use Node.js 24:

```sh
npm ci
npm install -g @masumi_network/sokosumi@1.0.4
npm run check
npm run build:worker
```

Configure private runtime settings in `.env.local` or hosted secret storage:

```dotenv
SOKOSUMI_COWORKER_ID=01a11100-48ed-74a7-b050-f616bc9751d6
SOKOSUMI_COWORKER_API_KEY=<dedicated coworker runtime key>
ORIGIN_TRAVEL_URL=https://origin-travel-agent.vercel.app
SOKOSUMI_WORKER_DATA_PATH=.data/sokosumi-worker
```

Process environment takes precedence over `.env.local`, then `.env`. Never use a human OAuth token or Masumi platform key as the worker credential.

```sh
npm run sokosumi:worker
# One bounded poll:
npm run sokosumi:worker -- --once
# Production entry point:
node dist-worker/scripts/sokosumi-worker.js
```

Use one executor per Coworker. The local process lock protects shared storage, but is not a distributed lease. Stop the local worker before hosting. Persist its journal on a volume.

## Judge task

Select Origin Travel Search in a granted Workspace. Create a READY task and paste [examples/sokosumi-trip.json](../examples/sokosumi-trip.json) as its description. Update dates as necessary. Raw JSON or a single JSON code fence is accepted. This task performs searches only.

The automatic rehearsal compared 48 flights and five hotels. Its cheapest sandbox flight was 77.71 EUR and cheapest hotel was 247.24 USD. It deliberately left the combined total unset because currencies differ. Those observations are not reusable booking quotes.

## Recovery and limits

The worker journals input, phase, response, exact answer, and completion evidence. Read-only searches may repeat after a crash before saving results. Runtime writes are not blindly repeated. Uncertain completion is reconciled against a matching event; unresolved writes require operator inspection. Assignment, RUNNING state, and unchanged input are checked before completion. Task listing follows pagination and failures are isolated.

Invalid input moves a task to INPUT_REQUIRED; supplier failure moves it to FAILED. Both block the journal. Follow-up input does not resume automatically in this version. An operator must inspect and explicitly repair the same task and journal before retrying. Core enforces Vendor Workspace grants; grant failures block work.

This worker supports execution rehearsals only. It does not submit `masumiPayment`, bill usage, or advance MPS payments. The separate MIP-003 paid API does not automatically pay a Sokosumi task. A paid task bridge and seller collection evidence are still required.

## Event approval

An event owner/admin must approve the existing request. Reuse the Coworker:

```sh
sokosumi --preprod coworkers connect 01a11100-48ed-74a7-b050-f616bc9751d6 \
  --vendor-id 01a11100-22ad-74ca-8076-05a63cbabe04 \
  --workspace-id 01a109d1-32a9-71a3-a0e3-658b2a7987cd --json
sokosumi --preprod workspaces check 01a109d1-32a9-71a3-a0e3-658b2a7987cd --json
```

Check the runtime Vendor grant separately, plus credits and eligibility. Event task commands use `--organization-slug token2049-origins-hackathon-2026-nws2r7`; runtime commands use `--organization-id 01a109d1-32a9-71a3-a0e3-658b2a7987cd`.

## Vercel hosting

The hosted request handler at `POST /v1/sokosumi/tick` checks assigned work and executes at most one task per invocation. It uses Neon operation journals and PostgreSQL session advisory locks, so concurrent function instances cannot execute the same task together. Exact answers are saved before completion. The endpoint returns only a generic status; task contents and results remain in Sokosumi. It accepts no caller-selected task or input.

Open https://origin-travel-agent.vercel.app/coworker and click **Check for tasks**. Keep that page open while testing in Sokosumi. It wakes the Vercel runner every ten seconds. The developer's laptop can be offline; the requesting browser must remain active. This is an on-demand runner, not a continuous background worker. Tasks will wait if no browser or approved scheduler invokes it. Vercel Hobby's daily cron does not provide prompt task pickup.

The Coworker ID and dedicated key are server-side Vercel environment variables. Supplier credentials and Neon storage use the existing project configuration. The local CLI worker remains an optional rehearsal tool; stop it before using the hosted runner because its file lock does not coordinate with Neon.

Railway has been unlinked from this checkout and its worker Dockerfile removed. No Railway service was activated. Historical stopped resources were not deleted.
