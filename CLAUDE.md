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
  2. `credit_cap_inr` is null, or unpaid usage is under it (postpaid accounts), and
  3. `balance_check_url` is null, or it returns `availableInr > 0`, or it does not answer (fail open; 1 s timeout, 30 s cache per org).
- The account owns its customers' wallets. voiceAi sends `usage.recorded` after each call, retried until delivered, never marked failed. No payment gateway in voiceAi. Payments are recorded by hand from the CLI.
- **Webhooks and reconciliation:** endpoints belong to the account (optional `org_id` filter). `usage.recorded` is retried until delivered (a check constraint forbids marking it failed). As a backup, the client stores the call id we return and polls `GET /v1/orgs/:externalId/calls/:id` until the call is finalized; debits are idempotent on `usageRecordId`, so webhook + poll never double-charge. No account-wide list endpoint for reconciliation.
- **`POST /v1/calls` returns the call id.** The API creates the `calls` row (`status = queued`, `request_id` = its id) before dispatch; the worker's open attaches to it through `requestId`. The `/internal/*` contract is unchanged.
- **Per-key concurrency:** each API key has `max_concurrent_calls` (default 1, set from the CLI). Calls the key placed in `queued` / `ringing` / `in_progress` hold a slot (`calls.api_key_id`); over the limit, `POST /v1/calls` gets 429, nothing is queued. `modules/calls/call-slots.ts` `withCallSlot` locks the key row while counting. Inbound calls hold no key's slot.
- **v1 feature set is still open:** campaigns, customer HTTP tools, knowledge search and test suites (evals) may be deferred. Core = accounts, keys, orgs, agents, versions, numbers, calls, events, billing, webhooks. Do not build the four optional features until confirmed.

## Infrastructure (phase 1: ~10,000 call-minutes/month)

| Piece | Choice |
| --- | --- |
| Hosting | **DigitalOcean, Bangalore (BLR1).** One Droplet, 4 vCPU / 8 GB, Docker Compose: 2 worker containers, api, background, Postgres 16, Redis 7, Caddy. Chosen over AWS because the worker streams ~3 MB/min of raw audio to Sarvam and DO includes the bandwidth. |
| Recordings and backups | **DigitalOcean Spaces, BLR1** (S3 API, stays in India). `RECORDING_S3_ENDPOINT=https://blr1.digitaloceanspaces.com`, `RECORDING_S3_REGION=blr1`. Code stays S3-generic; local dev uses MinIO. Lifecycle rules expire objects as the backstop to the retention job. |
| Media and SIP | **LiveKit Cloud, Ship plan ($50), India South.** Plivo Zentrunk → LiveKit SIP → room. |
| Worker | **Self-hosted** on our Droplet. Tested: LiveKit bills no agent minutes and applies no agent-session limit to a self-hosted worker. Never use LiveKit's agent hosting. |
| Public ingress | Caddy on 443 exposes `/v1` only (plus Plivo webhooks if adopted). `/internal/*` stays on the Docker network. Firewall: 443, 80, key-only SSH. The worker needs no inbound ports. |

### Operating rules

- **Two worker containers, deployed one at a time.** A single worker container makes every deploy an inbound outage while it drains.
- `stop_grace_period` ≥ `TELEPHONY_MAX_CALL_SECONDS` + 3 min (upload 120 s + analysis 45 s). Docker's default 10 s kills live calls.
- Bake the turn-detector and Silero models into the worker image at build time.
- Sessions start with `record=False`. On LiveKit Cloud, `record=True` uploads audio and transcripts to LiveKit (consent, DPDP). Record only with our recorder.
- Postgres backup = continuous WAL archiving to Spaces (WAL-G or pgBackRest) for point-in-time recovery, plus a tested restore. A nightly dump alone can lose a day of billing data.
- Compose services that others `depends_on: service_healthy` must define health checks (`pg_isready`, `redis-cli ping`).
- `DIALER_MAX_CONCURRENCY=5` in phase 1. Raise only with the Sarvam plan.
- Alert on any Sarvam HTTP 429 (callers hear silence). Rotate Docker logs at 50 MB.

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
- Who assigns pool numbers to orgs: /v1 (automitra picks) or the ops CLI. Blocks only that one route/command.
- Plivo answer URL in front of LiveKit (reject before LiveKit, fallback to the business's own number when we are down): pending Plivo's answer on how a Dial-to-SIP leg is billed.
- Local turn-detection model quality for Hindi/Hinglish on a self-hosted worker: verify on real calls.
- `availableInr` is sell-price headroom, but the worker caps its budget in Sarvam cost at list price, so a call can be charged more than `availableInr` (and the 30 s minimum alone is ₹3). Seen end to end: cap ₹10, a call with ₹2.50 left was charged ₹3.

## Layout

```
worker/   Python 3.13 + uv. Runs the live call. No database, no billing, no accounts.
api/      Bun + Hono + Drizzle. /internal (worker) and /v1 (accounts), background jobs, ops CLI. /internal, ops CLI, /v1 (except number assignment) and background jobs done; deploy files next.
schema/   agent-config.schema.json, GENERATED by worker. Never hand-edit.
docs/     adr/ (decisions), runbooks/ (one per alert).
compose.yaml  local Postgres 16, Redis 7, MinIO.
```

### worker/src/automitra_worker/

| Package | Holds |
| --- | --- |
| `entrypoint.py` | Prewarm, per-call entrypoint, `AgentServer`, `main` (the `agent` command) |
| `agent_config/` | `AgentConfigModel` (source of truth), Sarvam catalog, schema export, `RuntimeAgent` (config + composed prompt + greeting), dev-mode `environment.py`, `personas.py` + `seed_personas/` |
| `pipeline/` | `session.py` (STT/LLM/TTS/VAD/turn detection/failover), `realtime_stt.py`, `prompt.py`, `variables.py`, `greeting.py` |
| `cost/` | `prices.py` (Sarvam list prices, `usage_cost`), `usage_meter.py`, `call_budget.py`, `rate_ceiling.py`, `sentence_gate.py`, `call_cost_control.py` (one call's limits together), `estimate.py` + `costs_cli.py` |
| `pipeline/voice_assistant.py` | The call's Agent: replies pass the sentence gate; steering appended last to keep Sarvam's prompt cache |
| `call_tools/` | `end_call.py` (closing lines by hour), `transfer.py` (SIP REFER), `keypad.py`, `silence.py`; customer HTTP tools and knowledge only once confirmed |
| `telephony/` | `settings.py` (TELEPHONY_*/PLIVO_*), `outbound.py` (dial, failure classification), `voicemail.py`, `provisioning.py` + `cli.py` (`uv run telephony setup|call`) |
| `call.py` | One call once its agent is known: session, cost limits, events, finalize. `run_call` serves both modes |
| `control_plane/` | `contract.py` (the `/internal/*` shapes, exported to `schema/internal-api.schema.json`), `client.py` (the only code that calls the API), `resolution.py` (job metadata or dialled number → agent) |
| `reporting/` | `event_buffer.py`, `call_events.py`, `latency.py`, `call_outcome.py`, `finalize.py`, `recording.py` (RecorderIO → one SigV4 PUT to Spaces), `analysis.py` (summary, disposition, fields, QA; checked against the config) |

### api data model (`api/src/db/schema/`)

14 tables, replacing the spec's Data model: `accounts`, `api_keys`, `orgs` (tenancy.ts); `agents`, `agent_versions` (agents.ts); `phone_numbers`, `calls`, `call_events`, `suppressed_numbers` (calls.ts); `rate_cards`, `usage_records`, `account_ledger` (billing.ts); `webhook_endpoints`, `webhook_deliveries` (webhooks.ts). No `org_balances`: unpaid usage is summed from `account_ledger`. Optional-feature tables are not created; `calls.campaign_id` / `contact_id` have no FK yet.

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

- `modules/agents/resolve-call.ts`: pinned version, else agent's live version (candidate for `candidate_percent` of calls), else the assigned number's agent. Then org claim (403), deleted org / archived agent / no live version (404), suspended org (402), credit check (402).
- `modules/billing/credit-check.ts` (the one check): account active; `availableInr` = least of (credit cap − unpaid), (daily cap − today's usage, IST day), balance URL answer; null when nothing limits. Balance URL: 1 s timeout via an explicit timer (Bun's `AbortSignal.timeout` does not fire while the loop is idle), 30 s cache per org, fails open with an `ALERT` log.
- `modules/billing/pricing.ts`: billable = `durationSeconds` rounded up to the card's increment, never under its minimum; 0 for a call that never connected. The worker sends no usage for unanswered calls, so they write no usage row. PSTN cost by longest prefix of the other party's number. Included minutes per IST calendar month. A missing rate costs 0 and sets `needs_review` (g11).
- `modules/calls/finalize-call.ts`: one transaction, call row locked: outcome, do-not-call entry, usage record, ledger entry, `call.ended` + `usage.recorded` webhooks, `account.credit_low` once when a charge crosses 80% of the cap.
- `modules/privacy/redact.ts` (g19): with `redact_pii`, masks runs of 6+ digits (any script), emails and PAN in event content/payloads, summary and analysis fields. The call's own from/to numbers and the do-not-call list are kept.
- Webhook payloads: `usage.recorded` = `{orgId: externalId, callId, usageRecordId, priceInr}`; `call.ended` = `{call: toPublicCall(...), transcript}` (`modules/calls/public-call.ts`, also the future `GET /v1/.../calls/:id` shape).
- Route tests check every request and response against `schema/internal-api.schema.json` with ajv (`test/contracts/worker-contract.ts`), using `test/http/scenario.ts`. Tests have a 30 s timeout via `test/setup.ts` (bunfig's `timeout` key is ignored).
- API guarantee tests: 1, 2 (cold path only; no cache yet), 3, 6, 9, 10, 11 (pricing), 16, 19. Each was checked by removing the code it protects.

### api ops CLI (step 3, done)

`bun run cli help` lists every command. Groups: `account` (create, limits, show, list, suspend [--end-live-calls], resume, payment, adjust), `key` (create, list, revoke, concurrency), `rate-card` (seed, add, list), `number` (add, list). Needs only `DATABASE_URL` and `SECRETS_KEY`; `--end-live-calls` also needs `LIVEKIT_*` and ends rooms through `livekit.ts`.

- Keys: `am_live_` + 32 random bytes base64url; prefix = first 16 characters; SHA-256 hex stored (`modules/keys/api-keys.ts`, reused by /v1 auth).
- Payments and adjustments are idempotent on `--ref`. Negative amounts need `--amount=-500` (Node's parser reads `-500` as a flag).
- `rate-card seed` = the spec's card (₹6/min, 30 s min, 1 s increments; Sarvam list costs; +91 PSTN ₹0.785/min = Plivo 0.40 + LiveKit SIP 0.385). Adding a card closes the owner's open card at the new card's start.
- Number assignment to orgs is not in the CLI: waiting on whether /v1 or ops assigns numbers.
- `bun run db:migrate` applies `drizzle/` to `DATABASE_URL` (run before the api starts on each deploy).
- Verified end to end on Postgres 16 (not PGlite): CLI setup, then the worker's real `ControlPlaneClient` resolving, opening (retry = same id), events (retry inserts 0), three simultaneous finalizes (one charge, ₹7.50 for 75 s), `account.credit_low` at 80%, 402 at the cap; `withCallSlot` with 12 parallel connections placed exactly the limit.

### api /v1 (step 4, done except number assignment)

Every request: `Authorization: Bearer am_live_...`, checked each time (revoked/expired 401, suspended account 403), then a per-key rate limit (`PUBLIC_API_RATE_PER_MIN`, in-process: one api container; move to Redis before a second). Scopes: `orgs:read|write` (orgs, agents, versions, an org's numbers), `calls:read|write`. Another account's org is 404.

| Route | Does |
| --- | --- |
| `GET /v1/orgs`, `PUT/GET/DELETE /v1/orgs/:externalId` | Upsert by the account's id; delete = soft, numbers back to pool, agents archived, id retired (409) |
| `GET/POST /v1/orgs/:x/agents`, `GET/DELETE .../agents/:id` | Create = agent + version 1 as draft; delete = archive |
| `PUT .../agents/:id/draft`, `POST .../publish {versionId?}`, `PUT .../experiment {versionId, percent}`, `GET .../versions` | Every save is a new version (g16); publish moves `live`; experiment sets `candidate` |
| `GET .../numbers`, `PUT .../numbers/:e164 {agentId}` | Which agent answers each of the org's numbers |
| `POST .../calls {agentId, to, from?, variables?}` | 202 + the call. Refusals: 404 agent, 422 do-not-call (g13) / +91 outside 09:00–21:00 IST (g14) / no live version / no caller ID, 402 credit, 429 key concurrency, 503 dispatch failed or outbound not configured (the call row is marked failed, freeing its slot) |
| `GET .../calls?before&limit&disposition`, `GET .../calls/:id` | Newest first, cursor paging; one call includes its transcript (the poll fallback) |

- Agent configs are checked by `modules/agents/agent-config.ts` (ajv over `schema/agent-config.schema.json` + the five hand rules); g17 runs every shared case.
- Dispatch metadata (camelCase, read by the worker's `JobMetadata`): `placeCall, direction, orgId, agentId, agentVersionId, toNumber, fromNumber, phoneNumberId, variables, requestId` (= call id). Outbound needs `LIVEKIT_URL/API_KEY/API_SECRET` + `TELEPHONY_AGENT_NAME` (all or none); without them the api starts with outbound off.
- Webhook endpoints are account settings, managed from the ops CLI (`webhook add|list|disable|enable`), not /v1.

### api background (step 5, done)

`bun run background` (`src/background.ts`, same image as the api). Needs `DATABASE_URL`, `SECRETS_KEY`, `TELEPHONY_MAX_CALL_SECONDS` and `RECORDING_S3_*` (delete access). Jobs (`src/jobs/jobs.ts`, run by `jobs/runner.ts`: each on its own interval, never overlapping itself, a failure logs and retries next tick):

| Job | Every | Does |
| --- | --- | --- |
| deliver-webhooks | 2 s | Leases due rows 2 min (`FOR UPDATE SKIP LOCKED`; two processes split the queue, checked on Postgres 16), POSTs through the SSRF guard with a 10 s timeout. Body `{id, type, createdAt, data}`; headers `X-Automitra-Timestamp`, `X-Automitra-Signature: sha256=<HMAC("<ts>.<body>")>`, `X-Automitra-Event-Id: <event>:<eventKey>`. Retries 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, then failed; `usage.recorded` keeps retrying every 12 h and never fails. Disabled endpoints keep their queue. |
| usage-delivery-watch | 1 min | ALERT when the oldest pending `usage.recorded` is over 15 min old |
| sweep-stale-calls | 1 min | `queued` over 5 min → failed `dispatch_lost` (g15). Ringing/in progress past max call + 5 min → failed `worker_lost`, left unfinalized so a late finalize still bills |
| recording-retention | 1 h | Deletes recordings past the org's retention, sets `recording_deleted_at`; a failed delete retries next pass |
| prune-webhook-deliveries | 1 day | Deletes delivered/failed rows over 30 days old; never pending |

- SSRF guard (`modules/webhooks/safe-fetch.ts`, g05): https only, no credentials in the URL; resolves once, every address must be public (private, loopback, link-local/metadata, CGNAT, ULA, mapped and NAT64 forms blocked); connects to the checked address through node:http `lookup` (Bun calls it in the `all` form) so TLS still verifies the hostname; never follows redirects. Also checked when an endpoint is added.
- Alerts are log lines `ALERT <name>: ...`; each name has `docs/runbooks/<name>.md`: balance-check-failed-open, credit-low, usage-undelivered, webhook-delivery-failed, lost-dispatch, lost-worker, recording-retention.

### api/src/ (planned)

`routes/` stay thin (parse, call a module, respond). `modules/` hold all logic and never import HTTP types. Auth is by folder: `routes/internal/` behind the internal secret, `routes/v1/` behind an API key, `routes/v1/orgs/` additionally behind org scope (account + externalId → org, else 404). `jobs/` are loops for `background.ts` that only call modules.

## Build order (worker first)

1. Agent config model + schema export + drift test
2. Speech pipeline in `agent console` (single-tenant dev mode, no API needed)
3. Cost ceilings + `costs` CLI (guarantees 7, 8)
4. Reporting against a fake control plane; `/internal/*` shapes as pydantic models in `control_plane/contract.py`, exported for the API
5. Telephony (needs real Plivo and LiveKit accounts)
6. Recording (port the prototype's `CallRecorder`), post-call analysis, QA

**Status:** worker steps 1–6 built, 393 tests, all offline. Worker-side guarantee tests: 1, 7, 8, 9, 15, 16, 17 (worker halves where the API owns the rest), 18, 20, 21; 1, 7, 8, 18 and 20 were checked by breaking the code and seeing the tests fail. **Not yet live:** no real conversation, Plivo call, Spaces upload or Sarvam analysis has run; that needs `worker/.env` with LiveKit, Sarvam, Plivo and Spaces credentials. Step 5's "billed" and recording/analysis reaching a call record need the API. **Next: the API** (`api/`), starting from `schema/internal-api.schema.json`.

- Step 4 fixes to the prototype: a resolved `availableInr` of 0 or less refuses the call (the prototype capped the budget to 0, which switches the budget *off*); latency now reports the dominant component, as the spec requires.
- The API must implement `schema/internal-api.schema.json` exactly. Writes are idempotent on `lkJobId` (open), (call id, `seq`) (events) and call id (finalize). `orgId` on resolve is a claim to check, never a filter.
- Tests use an in-process fake API (`tests/fake_control_plane.py`) that checks the secret header and validates every body against the contract.
- Step 6: recording starts once answered and the greeting then discloses it; the upload and the analysis run in the AgentServer's `on_session_end` hook (`call.run_post_call_step`), with the upload retried from shutdown as a backup. Analysis tokens are added to the call's reported usage. `CallAnalysis` is typed in the contract.
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
bun test                # PGlite, no Docker or network
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
uv run telephony call +91XXXXXXXXXX   # one outbound call through the running worker
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
- Ask, don't guess, on: anything in Open items or the spec's Open questions, billing, consent, calling-hour rules, and the v1 feature set.
