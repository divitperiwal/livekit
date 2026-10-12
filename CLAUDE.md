# voiceAi

Voice-as-a-service backend for automitra. AI agents answer and place phone calls in Hindi, Hinglish and other Indic languages. Backend only: no web UI here. Other apps (automitra's main API first, outside clients later) use it through `/v1` with API keys that only we issue.

## Source of truth

- **Spec:** "automitra — Production Rebuild Spec", a Claude Docs doc: https://claude.ai/code/artifact/a0576a6b-28a0-43d5-8766-db515c2b0316. Read it with the Claude Docs connector, never by web fetch. It is long, so read the outline first, then only the section you need.
- The spec's **Billing** section is current. Its Data model, guarantees, trust boundaries, dashboard, layout and hosting assumptions predate the decisions below. **Where they conflict, this file wins.**
- The "Automitra Production Blueprint" (2 Oct 2026) measured the costs and limits used in Infrastructure below. Where it assumes a dashboard or the prototype codebase, this file wins.
- **Phase 1 launches on this rebuild.** The prototype (`automitra/livekit-python`) is never deployed to production; it is the reference implementation only. Its proven parts are ported, not rewritten: worker-side recording (`CallRecorder` on `RecorderIO`, Signature V4 upload, its tests) and the `costs` model.

## Decisions already made (do not re-open)

- **Backend only.** No dashboard, no users, no logins, no invites, no sessions. Remove `users`, `org_members`, `invites` from the spec's data model.
- **Two tenant levels.** An **account** is an API client we create (automitra, later outside clients). An **org** belongs to one account and is identified by the account's own id (`orgs.external_id`, unique per account).
- **Keys:** only we issue them, from the ops CLI (`api/src/cli.ts`). Stored as SHA-256 hash + prefix. Revocable immediately. Revoking a key stops API requests only; `account suspend` stops everything (keys, campaigns, inbound, optionally live calls).
- **Money:** one credit check, one function (`api/src/modules/billing/credit-check.ts`). A call starts only if:
  1. `accounts.status` is `active`, and
  2. `credit_cap_inr` is null, or unpaid charges (call usage + number rent) are under it (postpaid accounts), and
  3. `balance_check_url` is null, or it returns `availableInr > 0`, or it does not answer (fail open; 1 s timeout, 30 s cache per org).
- The account owns its customers' wallets. voiceAi sends `usage.recorded` after each call, retried until delivered, never marked failed. No payment gateway in voiceAi. Payments are recorded by hand from the CLI.
- **Webhooks and reconciliation:** endpoints belong to the account (optional `org_id` filter). `usage.recorded` is retried until delivered (a check constraint forbids marking it failed). As a backup, the client stores the call id we return and polls `GET /v1/orgs/:externalId/calls/:id` until the call is finalized; debits are idempotent on `usageRecordId`, so webhook + poll never double-charge. No account-wide list endpoint for reconciliation.
- **`POST /v1/calls` returns the call id.** The API creates the `calls` row (`status = queued`, `request_id` = its id) before dispatch; the worker's open attaches to it through `requestId`. The `/internal/*` contract is unchanged.
- **Per-key concurrency:** each API key has `max_concurrent_calls` (default 1, set from the CLI). Calls the key placed in `queued` / `ringing` / `in_progress` hold a slot (`calls.api_key_id`); over the limit, `POST /v1/calls` gets 429, nothing is queued. `modules/calls/call-slots.ts` `withCallSlot` locks the key row while counting. Inbound calls hold no key's slot.
- **Numbers, KYC and rent** (decided 11 Oct 2026; plan: "voiceAi numbers, KYC and rent: build plan", https://claude.ai/code/artifact/eefc802e-b6db-48d8-8c81-2b39838ebfd3):
  - All numbers live in our one Plivo account. Two ways to get one: **rented** through `/v1` by a key with the `numbers:rent` scope (granted from the CLI to our own platform's keys only: automitra), or **assigned** by us from the CLI (managed accounts such as marcofed, which pay us by bank transfer at a price we set; voiceAi never charges their rent). A number never moves to another business: unassigning or releasing returns it to Plivo.
  - **KYC is per org** (a Plivo compliance application; documents go straight to Plivo, never stored). Only `accepted` may rent or be assigned a number (409) or call: `POST /v1/calls` 422 (before the credit check), incoming calls 402. **Suspended** (Plivo: unresolved spam complaints, lifted with consent proof) or **expired** (needs a new application): calls are blocked at once, the account is told (`number_kyc.updated`), and a number whose next monthly charge comes before KYC is fixed is released instead of renewed.
  - **Rent** is wholesale (account → us): monthly, upfront, counted from the rent date; no refund on an early release; the price is the rate card's `numberMonthlyRentInr`, fixed when rented. automitra checks the business's wallet before renting; voiceAi checks only that the account is active and under its credit cap. Renewals always charge. `number.rent_charged` is retried until delivered, like `usage.recorded`.
  - Deleting an org is refused (409) while it holds numbers; automitra takes a number off WhatsApp before releasing it.
  - The WhatsApp verification-code window waits for Plivo's answer on SMS to Indian numbers.
- **v1 feature set is still open:** campaigns, customer HTTP tools, knowledge search and test suites (evals) may be deferred (12 Oct 2026: none of them yet). Core = accounts, keys, orgs, agents, versions, numbers, calls, events, billing, webhooks. Do not build the four optional features until confirmed.
- **Decided 12 Oct 2026:**
  - **A call may cost more than `availableInr`** (the worker caps Sarvam cost at list price, and the 30 s minimum alone is ₹3). The account (automitra) handles the shortfall; voiceAi does not turn credit into a time limit.
  - **Recordings:** `GET /v1/orgs/:x/calls/:id/recording` returns a signed link that works for 5 minutes.
  - **Do-not-call is not managed through `/v1`.** The list grows from caller opt-outs and UCC complaints only.
  - **Consent proof goes through `/v1`:** Plivo's UCC complaints are polled, stored per org and sent to the account; the business answers each with opt-in proof (`POST .../ucc-complaints/:ref/proof`). A complainant goes on the org's do-not-call list at once (Plivo: calling them again is itself a violation).
  - **`TELEPHONY_MAX_CALL_SECONDS=600`** (10 minutes).

## Infrastructure (phase 1: ~10,000 call-minutes/month)

| Piece | Choice |
| --- | --- |
| Hosting | **DigitalOcean, Bangalore (BLR1).** One Droplet, 4 vCPU / 8 GB, Docker Compose: 2 worker containers, api, background, Postgres 16, Redis 7, Caddy. Chosen over AWS because the worker streams ~3 MB/min of raw audio to Sarvam and DO includes the bandwidth. |
| Recordings and backups | **DigitalOcean Spaces, BLR1** (S3 API, stays in India). `RECORDING_S3_ENDPOINT=https://blr1.digitaloceanspaces.com`, `RECORDING_S3_REGION=blr1`. Code stays S3-generic; local dev uses MinIO. Lifecycle rules expire objects as the backstop to the retention job. |
| Media and SIP | **LiveKit Cloud, Ship plan ($50), India South.** Plivo Zentrunk → LiveKit SIP → room. |
| Worker | **Self-hosted** on our Droplet. Tested: LiveKit bills no agent minutes and applies no agent-session limit to a self-hosted worker. Never use LiveKit's agent hosting. |
| Public ingress | Caddy on 443 exposes `/v1` and `/plivo/*` (Plivo's KYC callback) only. `/internal/*` stays on the Docker network. Firewall: 443, 80, key-only SSH. The worker needs no inbound ports. |

### Operating rules

- **Two worker containers, deployed one at a time.** A single worker container makes every deploy an inbound outage while it drains.
- `stop_grace_period` ≥ `TELEPHONY_MAX_CALL_SECONDS` + 4 min (upload 120 s + analysis 45 s + finalize retries 60 s). Docker's default 10 s kills live calls.
- Bake the turn-detector and Silero models into the worker image at build time.
- Sessions start with `record=False`. On LiveKit Cloud, `record=True` uploads audio and transcripts to LiveKit (consent, DPDP). Record only with our recorder.
- Postgres backup = continuous WAL archiving to Spaces (WAL-G or pgBackRest) for point-in-time recovery, plus a tested restore. A nightly dump alone can lose a day of billing data.
- Compose services that others `depends_on: service_healthy` must define health checks (`pg_isready`, `redis-cli ping`).
- `DIALER_MAX_CONCURRENCY=5` in phase 1. Raise only with the Sarvam plan. (It belongs to the deferred campaigns dialer and does not exist yet: see Open items.)
- Alert on any Sarvam HTTP 429 (callers hear silence): `ALERT sarvam-rate-limited`, from the worker. Rotate Docker logs at 50 MB.

### Cost inputs (₹96.29/USD, 2 Oct 2026, before 18% GST)

| Item | Rate |
| --- | --- |
| Plivo | ₹0.40/min (check it covers inbound and outbound) |
| LiveKit SIP | $0.004/min after 5,000 included on Ship (≈ ₹0.385) |
| Sarvam | ≈ ₹2.01/min at list price (from the `costs` model), under the default `max_inr_per_min` ceiling of ₹2.50 (agents may set 1.0–2.5). |
| Marginal cost per minute | ≈ ₹2.79; ≈ ₹3.55 all-in at 10k min/month |
| Recordings | ≈ 1 MB/min (16 kHz stereo Opus, measured); default retention 30 days |

### Limits and upgrade triggers

| Trigger | Action |
| --- | --- |
| Peak ≈ 5 concurrent calls (Sarvam Starter LLM limit, 40 req/min) | Upgrade Sarvam plan, then raise `DIALER_MAX_CONCURRENCY` |
| ~30k min/month | Prepare self-hosted LiveKit: staging server, test DTLN noise suppression against Krisp on real noisy calls |
| ~50k min/month | Self-host LiveKit server + SIP on 2 small Droplets (SIP accepts Plivo IPs only), move a few numbers first, keep Cloud Build as cold standby |
| ~150k min/month or ~15 calls per worker server | Second worker Droplet; API, Postgres, Redis move to their own Droplet |
| ~300k min/month or a customer needs DB failover | DO managed Postgres |

None of these needs a code change: the code only knows `LIVEKIT_URL`, `DATABASE_URL`, `REDIS_URL` and the S3 endpoint.

## Open items (ask before deciding)

- v1 feature set (above).
- Plivo: are we registered as a reseller; does each number type need its own KYC application per business; can Indian numbers receive SMS and be WhatsApp senders (decides the verification window).
- The rent price per number (₹/month) for the rate cards: renting is refused (422) on a card without `numberMonthlyRentInr`.
- LiveKit support must enable `allowed_addresses` on the project before the inbound trunk can be restricted to Plivo.
- Plivo answer URL in front of LiveKit (reject before LiveKit, fallback to the business's own number when we are down): pending Plivo's answer on how a Dial-to-SIP leg is billed.
- Local turn-detection model quality for Hindi/Hinglish on a self-hosted worker: verify on real calls.
- No limit on concurrent calls overall: `DIALER_MAX_CONCURRENCY` is the deferred dialer's, per-key `max_concurrent_calls` limits only outbound calls per key, and inbound calls are unlimited. Sarvam Starter manages about 5 concurrent calls.
- Plivo's UCC callback (one HTTPS URL per account, set in its dashboard, V3-signed) is not used: complaints are polled every 5 minutes, enough for a 5-business-day deadline.

## Layout

```
worker/   Python 3.13 + uv. Runs the live call. No database, no billing, no accounts.
api/      Bun + Hono + Drizzle. /internal (worker), /v1 (accounts), /plivo (callbacks), background jobs, ops CLI. All built, numbers and KYC included.
deploy/   Production compose for the Droplet, Caddyfile, deploy.sh, backup.sh, README (setup, deploy, restore).
.github/workflows/ci.yml  api (types, Prettier, tests, migration drift), every migration on Postgres 16, worker (ruff, pytest, schema drift).
schema/   agent-config.schema.json, GENERATED by worker. Never hand-edit.
docs/     adr/ (decisions), runbooks/ (one per alert).
compose.yaml  local Postgres 16, Redis 7, MinIO.
```

### worker/src/automitra_worker/

| Package | Holds |
| --- | --- |
| `entrypoint.py` | Prewarm, per-call entrypoint, `AgentServer`, `main` (the `agent` command) |
| `agent_config/` | `AgentConfigModel` (source of truth), Sarvam catalog, schema export, `RuntimeAgent` (config + composed prompt + greeting), dev-mode `environment.py`, `personas.py` + `seed_personas/` |
| `pipeline/` | `session.py` (STT/LLM/TTS/VAD/turn detection/failover), `rate_limit_alert.py` (every Sarvam object, analysis included, logs `ALERT sarvam-rate-limited` on a 429; watched directly because a fallback adapter hides its primary's errors), `realtime_stt.py`, `prompt.py`, `variables.py`, `greeting.py` |
| `cost/` | `prices.py` (Sarvam list prices, `usage_cost`), `usage_meter.py`, `call_budget.py`, `rate_ceiling.py`, `sentence_gate.py`, `call_cost_control.py` (one call's limits together), `estimate.py` + `costs_cli.py` |
| `pipeline/voice_assistant.py` | The call's Agent: replies pass the sentence gate; steering appended last to keep Sarvam's prompt cache |
| `call_tools/` | `end_call.py` (closing lines by hour), `transfer.py` (SIP REFER), `keypad.py`, `silence.py`; customer HTTP tools and knowledge only once confirmed |
| `telephony/` | `settings.py` (TELEPHONY_*/PLIVO_*), `outbound.py` (dial, failure classification), `voicemail.py`, `provisioning.py` + `cli.py` (`uv run telephony setup|call`). The trunks list no numbers: inbound takes any number from `PLIVO_ALLOWED_ADDRESSES` only (required), outbound allows any caller ID and each dial names the org's number |
| `call.py` | One call once its agent is known: session, cost limits, events, finalize. `run_call` serves both modes |
| `control_plane/` | `contract.py` (the `/internal/*` shapes, exported to `schema/internal-api.schema.json`), `client.py` (the only code that calls the API), `resolution.py` (job metadata or dialled number → agent) |
| `reporting/` | `event_buffer.py`, `call_events.py`, `latency.py`, `call_outcome.py`, `finalize.py`, `recording.py` (RecorderIO → one SigV4 PUT to Spaces), `analysis.py` (summary, disposition, fields, QA; checked against the config) |

### api data model (`api/src/db/schema/`)

16 tables, replacing the spec's Data model: `accounts`, `api_keys`, `orgs` (tenancy.ts); `agents`, `agent_versions` (agents.ts); `phone_numbers`, `calls`, `call_events`, `suppressed_numbers`, `ucc_complaints` (calls.ts); `rate_cards`, `usage_records`, `number_rents`, `account_ledger` (billing.ts); `webhook_endpoints`, `webhook_deliveries` (webhooks.ts). No `org_balances`: unpaid charges are summed from `account_ledger`. Optional-feature tables are not created; `calls.campaign_id` / `contact_id` have no FK yet.

- `phone_numbers`: `source` (`managed` / `rented`), status `renting → assigned → releasing → released` (`available` = in our pool, no org), `monthly_rent_inr`, `rented_at`, `released_at`, `rent_request_key` (the client's Idempotency-Key, unique per org). `e164` is unique only among numbers not released, so a number can be bought again; released rows stay as history.
- `orgs`: `number_kyc_status` (`none`, `submitted`, `accepted`, `rejected`, `suspended`, `expired`; Plivo's words), Plivo's application id, rejection reason.
- `number_rents`: one row per number per month, unique on (number, period start), linked from the ledger like `usage_records`. Ledger kinds: `usage`, `number_rent`, `payment`, `adjustment`.
- `ucc_complaints`: one row per Plivo complaint (`reference_id` unique), status `pending → in_review → accepted | rejected` (Plivo's words). `org_id` = the org holding `from_number` on the day of the call (the first of that number's rows not released before that day), null when none did. `suppressed_numbers.source` gains `complaint`.

- Tenancy is in the keys: composite FKs stop an agent pointing at another agent's version and a call running another org's version.
- Billing rows are `restrict`, never cascaded from an org. Orgs are soft-deleted.
- `drizzle/0001_immutable_rows.sql` (hand-written via `drizzle-kit generate --custom`): triggers make `account_ledger` append-only (g10) and `agent_versions` immutable except a one-time publish stamp (g16). Saving a draft writes a new version row.
- Tests run on PGlite (in-process Postgres) with the committed migrations: `test/db/test-database.ts`.

### api foundation

- `src/contracts/internal.ts`: Zod copy of the worker contract. `test/contracts/internal-contract.test.ts` compares it with `schema/internal-api.schema.json` (fields, required, nullability, enums, bounds); re-export from the worker and the API test fails on drift.
- `src/config.ts` validates env at startup and lists every bad variable. Only variables a built step needs are in it.
- Every error body is `{ error }` (`src/http/errors.ts`). `/internal` checks the secret by constant-time digest compare before any body is read (g06).
- `test/http/test-app.ts`: the real app over PGlite, called with `app.request`.

### api /internal (step 2, done)

- `modules/agents/resolve-call.ts`: pinned version, else agent's live version (candidate for `candidate_percent` of calls), else the assigned number's agent. Then org claim (403), deleted org / archived agent / no live version (404), suspended org (402), number KYC not accepted (402), credit check (402).
- `modules/billing/credit-check.ts` (the one check): account active; `availableInr` = least of (credit cap − unpaid), (daily cap − today's usage, IST day), balance URL answer; null when nothing limits. Balance URL: 1 s timeout via an explicit timer (Bun's `AbortSignal.timeout` does not fire while the loop is idle), 30 s cache per org, fails open with an `ALERT` log.
- `modules/billing/pricing.ts`: billable = `durationSeconds` rounded up to the card's increment, never under its minimum; 0 for a call that never connected. The worker sends no usage for unanswered calls, so they write no usage row. PSTN cost by longest prefix of the other party's number. Included minutes per IST calendar month. A missing rate costs 0 and sets `needs_review` (g11).
- `modules/calls/finalize-call.ts`: one transaction, call row locked: outcome, do-not-call entry, usage record, ledger entry, `call.ended` + `usage.recorded` webhooks, `account.credit_low` once when a charge crosses 80% of the cap.
- `modules/privacy/redact.ts` (g19): with `redact_pii`, masks runs of 6+ digits (any script), emails and PAN in event content/payloads, summary and analysis fields. The call's own from/to numbers and the do-not-call list are kept.
- Webhook payloads: `usage.recorded` = `{orgId: externalId, callId, usageRecordId, priceInr, billableSeconds, direction}` (the account prices the call with its own plan); `call.ended` = `{call: toPublicCall(...), transcript}` (`modules/calls/public-call.ts`, also the future `GET /v1/.../calls/:id` shape).
- Route tests check every request and response against `schema/internal-api.schema.json` with ajv (`test/contracts/worker-contract.ts`), using `test/http/scenario.ts`. Tests need a 30 s timeout (each builds a fresh PGlite): `bun run test` passes `--timeout 30000`. `setDefaultTimeout` in a preload and bunfig's `timeout` key each reach only one test file, so plain `bun test` leaves the rest at Bun's 5 s and fails at random.
- API guarantee tests: 1, 2 (cold path only; no cache yet), 3, 6, 9, 10, 11 (pricing), 16, 19. Each was checked by removing the code it protects.

### api ops CLI (step 3, done)

`bun run cli help` lists every command. Groups: `account` (create, limits, show, list, suspend [--end-live-calls], resume, payment, adjust), `key` (create, list, revoke, concurrency, scopes), `rate-card` (seed, add, list), `number` (add, list, assign, unassign), `org kyc` (submit, status), `webhook` (add, list, disable, enable). Needs only `DATABASE_URL` and `SECRETS_KEY`; `--end-live-calls` also needs `LIVEKIT_*` (ends rooms through `livekit.ts`); `number assign|unassign` and `org kyc` also need `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN`.

- Keys: `am_live_` + 32 random bytes base64url; prefix = first 16 characters; SHA-256 hex stored (`modules/keys/api-keys.ts`, reused by /v1 auth).
- Payments and adjustments are idempotent on `--ref`. Negative amounts need `--amount=-500` (Node's parser reads `-500` as a flag).
- `rate-card seed` = the spec's card (₹6/min, 30 s min, 1 s increments; Sarvam list costs; +91 PSTN ₹0.785/min = Plivo 0.40 + LiveKit SIP 0.385). Adding a card closes the owner's open card at the new card's start.
- `key create` never grants `numbers:rent`; `key scopes <prefix> ...` does.
- Managed numbers: buy by hand in Plivo, point at the inbound trunk in its console, `number add`, then `number assign` (needs accepted KYC; links the number to the org's Plivo application). `number unassign` releases it to Plivo (`releasing` if Plivo fails; the release job retries).
- `org kyc submit` sends a managed business's details and two files to Plivo (a new application, or a resubmission after a rejection; refused while submitted, accepted or suspended); `org kyc status` reads and stores Plivo's decision.
- `bun run db:migrate` applies `drizzle/` to `DATABASE_URL` (run before the api starts on each deploy).
- Verified end to end on Postgres 16 (not PGlite): CLI setup, then the worker's real `ControlPlaneClient` resolving, opening (retry = same id), events (retry inserts 0), three simultaneous finalizes (one charge, ₹7.50 for 75 s), `account.credit_low` at 80%, 402 at the cap; `withCallSlot` with 12 parallel connections placed exactly the limit.

### api /v1 (step 4, done)

Every request: `Authorization: Bearer am_live_...`, checked each time (revoked/expired 401, suspended account 403), then a per-key rate limit (`PUBLIC_API_RATE_PER_MIN`, in-process: one api container; move to Redis before a second). Scopes: `orgs:read|write` (orgs, agents, versions, an org's numbers, KYC), `calls:read|write`, `numbers:rent` (search, rent, release; ours only). Another account's org is 404.

| Route | Does |
| --- | --- |
| `GET /v1/orgs`, `PUT/GET/DELETE /v1/orgs/:externalId` | Upsert by the account's id; delete = soft, agents archived, id retired (409); refused (409, listing them) while the org holds numbers |
| `GET/POST /v1/orgs/:x/agents`, `GET/DELETE .../agents/:id` | Create = agent + version 1 as draft; delete = archive |
| `PUT .../agents/:id/draft`, `POST .../publish {versionId?}`, `PUT .../experiment {versionId, percent}`, `GET .../versions` | Every save is a new version (g16); publish moves `live`; experiment sets `candidate` |
| `GET .../numbers`, `PUT .../numbers/:e164 {agentId}` | Which agent answers each of the org's numbers |
| `GET /v1/numbers/available?pattern&city&limit` | Plivo's Indian numbers with the account's monthly rent (`numbers:rent`, 10 a minute per key); 422 if the card has no rent |
| `POST .../numbers {number}` + `Idempotency-Key` | Rent: 201 `{number, monthlyRentInr, rentedAt, nextChargeAt}`. Writes a `renting` row, buys under the org's application, points it at `PLIVO_INBOUND_TRUNK_ID`, charges the first month, sends `number.rented` + `number.rent_charged`. 409 KYC / number taken / Plivo refused (nothing saved), 402 credit cap, 422 no rent on the card or key reused for another number, 502 Plivo timeout (the same key resumes; never bought twice) |
| `DELETE .../numbers/:e164` | Release a rented number at once (202, `number.released`); 403 for a number we assigned |
| `PUT/GET .../number-kyc` | Multipart: `legalName, gstin, addressLine1, addressLine2?, city, state, postalCode` + files `registrationCertificate`, `gstCertificate` (PDF/JPEG/PNG, 5 MB each), straight to Plivo; 202 submitted, 409 already submitted/accepted/suspended, 422 bad file, 503 Plivo's requirements changed (ALERT) |
| `POST .../calls {agentId, to, from?, variables?}` | 202 + the call. Refusals: 404 agent, 422 do-not-call (g13) / +91 outside 09:00–21:00 IST (g14) / no live version / no caller ID / number KYC not accepted, 402 credit, 429 key concurrency, 503 dispatch failed or outbound not configured (the call row is marked failed, freeing its slot) |
| `GET .../calls?before&limit&disposition`, `GET .../calls/:id` | Newest first, cursor paging; one call includes its transcript (the poll fallback) |
| `GET .../calls/:id/recording` | `{url, expiresAt}`: a signed GET valid 5 minutes (`calls:read`); 404 when never recorded or past retention; 503 without `RECORDING_S3_*` on the api |
| `GET .../ucc-complaints`, `GET .../ucc-complaints/:ref` | The org's complaints, newest first (`orgs:read`) |
| `POST .../ucc-complaints/:ref/proof` | Multipart `file` (PDF/JPEG/PNG, 10 MB) straight to Plivo; 202, the complaint `in_review`. 409 under review, accepted, or Plivo refused it (e.g. past the window), 422 bad file, 404 another org's (`orgs:write`) |

- Agent configs are checked by `modules/agents/agent-config.ts` (ajv over `schema/agent-config.schema.json` + the five hand rules); g17 runs every shared case.
- Dispatch metadata (camelCase, read by the worker's `JobMetadata`): `placeCall, direction, orgId, agentId, agentVersionId, toNumber, fromNumber, phoneNumberId, variables, requestId` (= call id). Outbound needs `LIVEKIT_URL/API_KEY/API_SECRET` + `TELEPHONY_AGENT_NAME` (all or none); without them the api starts with outbound off.
- Webhook endpoints are account settings, managed from the ops CLI (`webhook add|list|disable|enable`), not /v1. A new endpoint subscribes to every event unless `--events` names some.
- Numbers need `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_INBOUND_TRUNK_ID`, `PUBLIC_BASE_URL` (all or none); without them those routes answer 503. Recording links need the five `RECORDING_S3_*` (all or none; read access). A Plivo failure reaching the error handler is 502 with Plivo's message.
- `POST /plivo/kyc/:orgId?token=` (`routes/plivo/`): the token is an HMAC of the org id under `SECRETS_KEY` (`modules/numbers/number-services.ts`), set as the application's callback URL. Plivo's callback body is undocumented, so it is never read: the status is re-read from Plivo. Wrong token or org: 404.
- Webhook payloads: `number.rented` `{orgId, number, monthlyRentInr, rentedAt, nextChargeAt}`; `number.rent_charged` `{orgId, number, numberRentId, amountInr, periodStart, periodEnd}` (bill on `numberRentId`); `number.released` `{orgId, number}`; `number_kyc.updated` `{orgId, status, rejectionReason}`; `ucc_complaint.updated` `{orgId, referenceId, status, fromNumber, complainantNumber, calledOn, category, rejectionReason, reportedAt, proofSubmittedAt}`, once per status change (a new complaint included), keyed `reference:status:time`.
- `modules/numbers/plivo.ts` is the only code that calls Plivo (search, buy, connect to the trunk, holds, release, compliance requirements/submit/resubmit/status/link, UCC complaints and proof); tests use `test/fixtures/fake-plivo.ts`, which keeps Plivo's rules. Plivo names numbers without the `+` in paths and with it in the link body.

### api background (step 5, done)

`bun run background` (`src/background.ts`, same image as the api). Needs `DATABASE_URL`, `SECRETS_KEY`, `TELEPHONY_MAX_CALL_SECONDS` and `RECORDING_S3_*` (delete access); the number jobs also `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` (both or neither; without them they do not run). Jobs (`src/jobs/jobs.ts`, run by `jobs/runner.ts`: each on its own interval, never overlapping itself, a failure logs and retries next tick):

| Job | Every | Does |
| --- | --- | --- |
| deliver-webhooks | 2 s | Leases due rows 2 min (`FOR UPDATE SKIP LOCKED`; two processes split the queue, checked on Postgres 16), POSTs through the SSRF guard with a 10 s timeout. Body `{id, type, createdAt, data}`; headers `X-Automitra-Timestamp`, `X-Automitra-Signature: sha256=<HMAC("<ts>.<body>")>`, `X-Automitra-Event-Id: <event>:<eventKey>`. Retries 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, then failed; billing events (`usage.recorded`, `number.rent_charged`) keep retrying every 12 h and never fail. Disabled endpoints keep their queue. |
| billing-delivery-watch | 1 min | ALERT `usage-undelivered` / `rent-undelivered` when the oldest pending one is over 15 min old |
| sweep-stale-calls | 1 min | `queued` over 5 min → failed `dispatch_lost` (g15). Ringing/in progress past max call + 5 min → failed `worker_lost`, left unfinalized so a late finalize still bills |
| recording-retention | 1 h | Deletes recordings past the org's retention, sets `recording_deleted_at`; a failed delete retries next pass |
| prune-webhook-deliveries | 1 day | Deletes delivered/failed rows over 30 days old; never pending |
| monthly-number-rent | 1 h | Charges each rented number's next month on its anniversary (IST calendar months from the rent date, clamped to month end; a missed run catches up; unique per period). KYC not accepted on that date: the number is released instead. Managed numbers are never charged |
| number-releases | 5 min | Retries releases Plivo did not confirm; ALERT `number-release-stuck` after 1 h |
| abandoned-rents | 5 min | A `renting` row 15 min old is undone: a bought number goes back to Plivo, the row is deleted; never completed (the business may have picked another number) |
| kyc-poll-pending / kyc-poll-accepted | 5 min / 6 h | Re-read KYC for `submitted`+`suspended` / `accepted` orgs; catches suspensions and expiries Plivo does not call back about; ALERT `kyc-poll-failed` |
| ucc-complaints | 5 min | Reads complaints reported in the last 45 days. A new one is matched to its org, its complainant goes on that org's do-not-call list, and `ucc_complaint.updated` is sent; so is every later status change. ALERT `ucc-complaint-unmatched` (no org held the number), `ucc-poll-failed` |

- SSRF guard (`modules/webhooks/safe-fetch.ts`, g05): https only, no credentials in the URL; resolves once, every address must be public (private, loopback, link-local/metadata, CGNAT, ULA, mapped and NAT64 forms blocked); connects to the checked address through node:http `lookup` (Bun calls it in the `all` form) so TLS still verifies the hostname; never follows redirects. Also checked when an endpoint is added.
- Alerts are log lines `ALERT <name>: ...`; each name has `docs/runbooks/<name>.md`: balance-check-failed-open, credit-low, usage-undelivered, rent-undelivered, webhook-delivery-failed, lost-dispatch, lost-worker, recording-retention, number-release-stuck, kyc-poll-failed, kyc-requirements-changed, ucc-complaint-unmatched, ucc-poll-failed, database-backup-failed (from `deploy/backup.sh`, via `logger`), sarvam-rate-limited (from the worker).

### deploy (done; checked locally on Docker 29, not yet on a Droplet)

`deploy/compose.yaml` + `deploy/.env` (from `.env.example`). `deploy.sh`: grace-period check, build, Postgres up, `pgbackrest stanza-create`, migrate, api + background + Caddy, then worker-a and worker-b one at a time with `--wait`.

- Each service gets only the variables it needs (no shared `env_file`). Images: `api/Dockerfile` (context = repo root, for `schema/`), `worker/Dockerfile` (uv, non-root, `agent start` under `init: true`), `deploy/postgres/Dockerfile` (postgres:16 + pgBackRest).
- Caddy serves `/v1/*` and `/plivo/*`; anything else gets `{"error":"not found"}` 404. Request bodies are capped at 1 MB, except 12 MB on `/v1/orgs/*/number-kyc` and `/v1/orgs/*/ucc-complaints/*/proof` (two mutually exclusive matchers). `caddy validate` (caddy 2.10) passes.
- After a deploy that changes the trunks, run `uv run telephony setup` once (in a worker container) so LiveKit picks up the new trunk settings.
- Backups: pgBackRest (chosen over WAL-G: an apt package from the PGDG repo the image already has). `archive_timeout=60`, encrypted (aes-256-cbc), zstd, 2 fulls kept; cron runs `backup.sh` (full weekly, diff daily). Its `pg1-user` must be `automitra`: there is no `postgres` role. A point-in-time restore was tested locally from a posix repo: it stopped at the target commit and the api came back up. Spaces itself is untested.
- Images must be built once per deploy and keep the same id when nothing changed, or every deploy restarts Postgres and the workers: one building service per image (`api`, `worker-a`; the others `pull_policy: never`) and `BUILDX_NO_DEFAULT_ATTESTATIONS=1` (provenance timestamps change the id).
- The local turn detector (`v1-mini`) is compiled into `livekit.local_inference`'s native module and loads offline in 0.5 s; `agent download-files` only fetches Silero. A drain with no live calls exits in about a second.
- Redis is not in production compose: nothing uses it yet (add it with the rate limiter move).
- `TELEPHONY_MAX_CALL_SECONDS=600`, `WORKER_STOP_GRACE_SECONDS=840`; `deploy.sh` refuses a grace period < it + 240.
- The worker finalizes from the session-end hook (5 minutes allowed), retrying for about a minute (1, 2, 4, 8, 15 s) on no answer, a timeout or a 5xx, so a call ending while the api restarts is still billed; the shutdown callback (about 10 s) repeats it only if the hook did not finish. Opening a call record retries twice (0.5, 1 s); events are not retried.

### api/src/ (planned)

`routes/` stay thin (parse, call a module, respond). `modules/` hold all logic and never import HTTP types. Auth is by folder: `routes/internal/` behind the internal secret, `routes/v1/` behind an API key, `routes/v1/orgs/` additionally behind org scope (account + externalId → org, else 404), `routes/plivo/` behind a per-org callback token. `jobs/` are loops for `background.ts` that only call modules.

## Build order (worker first)

1. Agent config model + schema export + drift test
2. Speech pipeline in `agent console` (single-tenant dev mode, no API needed)
3. Cost ceilings + `costs` CLI (guarantees 7, 8)
4. Reporting against a fake control plane; `/internal/*` shapes as pydantic models in `control_plane/contract.py`, exported for the API
5. Telephony (needs real Plivo and LiveKit accounts)
6. Recording (port the prototype's `CallRecorder`), post-call analysis, QA

**Status:** worker steps 1–6 built, 403 tests, all offline. Worker-side guarantee tests: 1, 7, 8, 9, 15, 16, 17 (worker halves where the API owns the rest), 18, 20, 21; 1, 7, 8, 18 and 20 were checked by breaking the code and seeing the tests fail. **Not yet live:** no real conversation, Plivo call, Spaces upload or Sarvam analysis has run; that needs `worker/.env` with LiveKit, Sarvam, Plivo and Spaces credentials. **Next:** the first live call (needs those credentials), then the first Droplet deploy (Spaces backups untested).

- Step 4 fixes to the prototype: a resolved `availableInr` of 0 or less refuses the call (the prototype capped the budget to 0, which switches the budget *off*); latency now reports the dominant component, as the spec requires.
- The API must implement `schema/internal-api.schema.json` exactly. Writes are idempotent on `lkJobId` (open), (call id, `seq`) (events) and call id (finalize). `orgId` on resolve is a claim to check, never a filter.
- Tests use an in-process fake API (`tests/fake_control_plane.py`) that checks the secret header and validates every body against the contract.
- Step 6: recording starts once answered and the greeting then discloses it; the upload, the analysis and finalize run in the AgentServer's `on_session_end` hook (`call.run_post_call_step`), repeated from the shutdown callback if the hook did not finish. Analysis tokens are added to the call's reported usage. `CallAnalysis` is typed in the contract.
- Step 5: Krisp is `krisp_enabled` on the LiveKit SIP trunk and dial request, not a plugin (the unused noise-cancellation dependency was removed). `uv run telephony call +91...` dispatches the worker with place-call metadata, so a test call takes the production outbound path (machine detection, dial, greet). Telephony settings are validated when the worker starts. Dial failures are classified from `SipCallError.sip_status_code`: 486/600/603 busy, 408/480/487 no answer, 404/410/484/604 unreachable (never retried).

- Fixed from the prototype: on the budget's wrap stage it passed `budget_farewell` to `session.say()`, which would read the default English *instruction* aloud. We use `generate_reply(instructions=budget_farewell)`.
- Reaching the hard stage closes the session at once, even mid-farewell (the spec's backstop).

### Worker runtime facts (verified against livekit-agents 1.8.4)

- `AgentServer` defaults to running calls as **threads**; we set `JobExecutorType.PROCESS` explicitly. One process per call gives crash isolation, makes applying per-call VAD settings to the prewarmed VAD safe, and is what the memory figures assume. Module-level per-call state (like the prototype's `_POST_CALL` table) is only safe because of this. The flip side: a job process exits when its call ends (livekit-agents 1.8.4 `job_proc_lazy_main.py`), so in-memory caches never outlive one call. The greeting `AudioCache` (`pipeline/greeting.py`) therefore never hits in production.
- Idle processes: `WORKER_IDLE_PROCESSES`, default 2 (LiveKit's production default of 12 would idle at ~3.4 GB per container).
- `inference.TurnDetector()` uses LiveKit's hosted `v1` model in dev mode and the local `v1-mini` (~108 MB) on a self-hosted `start`. Its weights and Silero's come from `uv run agent download-files`, which the Docker build must run.
- Dev mode is only for `INTERNAL_API_SECRET` unset; it reports nothing. With it set, every call is resolved through the API, and a call that cannot be resolved is ended unanswered.

### Agent config contract

- `AgentConfigModel` (`worker/src/automitra_worker/agent_config/model.py`) is the only definition. Valid models, modes, languages and voices come from the Sarvam plugin's tables (`sarvam_catalog.py`), so a plugin upgrade changes the schema; re-export and commit it.
- Stored form is camelCase: use `AgentConfigModel.from_stored()` / `.to_stored()` for anything from or to the API. Snake_case names are for worker code only.
- `schema/agent-config.cases.json` holds valid and invalid configs that both validators must judge the same way (guarantee 17). Add a case whenever a rule changes.
- The model follows the prototype's `agent_config_model.py` rule for rule, with one deliberate fix: `ttsPace` must be 0.3–3.0 (the Sarvam plugin raises mid-call below 0.3; the prototype accepted anything above 0).
- JSON Schema cannot express five rules, so the API must apply them by hand after ajv: voice exists on the TTS model (`x-tts-speakers`), `timezone` in `x-timezones`, `budgetWrapAt ≥ budgetWarnAt` when `budgetInr > 0`, `vadMinSilence ≥ 0.25` with the turn detector on, endpointing min ≤ max after mode defaults (0.3/2.5 with detector, 0.5/3.0 without).

## Commands

```
cd api
bun install
bun run test            # PGlite, no Docker or network; 30 s per test (plain `bun test` times out)
bun run typecheck
bun run format          # Prettier, 100 columns; format:check only checks
bun run dev             # needs DATABASE_URL, INTERNAL_API_SECRET (32+ chars), SECRETS_KEY (openssl rand -base64 32)
bunx drizzle-kit generate --name <what>   # after a schema change; "No schema changes" = in sync

cd worker
uv sync                 # install
uv run pytest           # tests
uv run ruff format src tests   # 100 columns
uv run agent console    # talk to the dev-mode agent in the terminal (needs SARVAM_API_KEY in worker/.env)
uv run agent download-files   # model weights (VAD, turn detector)
uv run costs            # what the dev-mode agent costs per minute
uv run telephony setup  # create/update LiveKit SIP trunks + dispatch rule, print Plivo steps
uv run telephony call +91XXXXXXXXXX --from +91YYYYYYYYYY   # one outbound call through the running worker
uv run python -m automitra_worker.agent_config.export_schema           # write schema/agent-config.schema.json
uv run python -m automitra_worker.agent_config.export_schema --check   # CI drift check
```

## Rules

- Reproduce every behaviour in the spec. Restructure code freely, but ask before dropping a guarantee.
- Every non-negotiable guarantee gets a test that fails on regression, named by number: `tests/guarantees/test_gNN_<what>.py` (worker), `test/guarantees/gNN-<what>.test.ts` (api). Tests run without credentials or network.
- Types first: pydantic models / Zod schemas before implementation.
- Self-documenting names over comments. Build only what the current step needs.
- Code must read easily on first pass: lines within 100 columns (Prettier / ruff format), no nested ternaries, one step per line, a named helper instead of a repeated block, braces on every multi-line `if`. In the api, give transaction callbacks their outcome type instead of `as const`, and use `.returning().then(onlyRow)` instead of `row!`.
- Money is INR; no currency conversion anywhere.
- Importing any worker module does no work (no network, no model loading). Models load in prewarm only.
- Migrations: `drizzle-kit generate`, reviewed and committed. Never `drizzle-kit push`.
- A new enum value: drizzle-kit emits `ALTER TYPE ... ADD VALUE`, and Postgres 16 refuses to *use* that value (a check, a default, an index predicate) in the same transaction; all pending migrations run in one. If any migration uses it, recreate the type instead (rename, create, `ALTER COLUMN ... USING ::text::`, drop; see `drizzle/0004_numbers_kyc_rent.sql`). PGlite does not catch this: apply every migration to a real Postgres 16 before committing.
- Ask, don't guess, on: anything in Open items or the spec's Open questions, billing, consent, calling-hour rules, and the v1 feature set.
