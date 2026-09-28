# @automitra/api

The control plane. Owns the database and everything that is not the live call:
organisations, users, agents, phone numbers, tools, call records and billing.

The schema, the internal API the worker talks to, billing, the dashboard's
API, the public API (`/v1`), and the background process: dialer, webhook
delivery, recording retention.

## Running it

From the repository root:

```bash
docker compose up -d      # postgres and redis
```

Then here:

```bash
bun install
bun run db:migrate        # apply migrations
bun run db:seed           # load KBS Motors as the first tenant
bun run db:studio         # browse the data
```

`DATABASE_URL` overrides the connection, which defaults to the local
docker-compose Postgres.

## The internal API

```bash
cp .env.example .env   # then set INTERNAL_API_SECRET
bun run dev
```

| Endpoint | Used for |
| --- | --- |
| `GET /health` | liveness, including the database |
| `GET /internal/resolve` | which agent a call runs as |
| `POST /internal/calls` | open a call record |
| `POST /internal/calls/:id/events` | append transcript turns |
| `POST /internal/calls/:id/finalize` | close a call, record usage and analysis, queue `call.ended` |
| `GET /internal/knowledge/search` | passages for the agent's `search_knowledge` tool |
| `GET /internal/eval-runs/:id` | a test run for the worker to play: scenarios and the version under test |
| `POST /internal/eval-runs/:id/results`, `/finish` | its results, as each scenario finishes |

`/internal/*` requires `x-internal-secret`. These endpoints serve any tenant's
configuration and accept writes against any call, so they carry no per-tenant
authorisation of their own — the worker is trusted and the boundary is the
network. **They must never be exposed publicly.**

### Resolving

`/internal/resolve` takes one of `agentVersionId`, `agentId` or `number`, plus
an optional `orgId`.

`orgId` is a *claim to be checked*, not a filter. A job whose metadata named
another tenant's agent is refused with 403 rather than served. The check runs
on the way out of the cache rather than inside the loader, because the cache is
keyed on what is being looked up and not on who is asking — putting it inside
would make it hold on a cache miss and lapse on a hit, which passes every test
that starts cold and fails only in production.

Writes are all idempotent, on `lkJobId`, on `(callId, seq)` and on the usage
record's key. The worker cannot promise to call any of them exactly once.

`/internal/resolve` also returns the version's enabled tools with their
secrets decrypted. That part is loaded after the cache on every call, never
from it, so decrypted credentials never reach Redis, and a tool that is edited
or disabled takes effect on the next call.

## The background process

```bash
bun run background
```

A separate process from the API, so each can be deployed and restarted
without pausing the other. Each tick it runs the dialer (see
`src/services/dialer.ts` for what one round does and why claiming is locked
per campaign) and webhook delivery (`src/services/webhooks.ts`, leased so two
processes never send the same event). On slower clocks it also runs
`sweepStaleCalls`, which nothing else schedules, deletes expired recordings,
and prunes old deliveries. The campaign rules are pure
functions in `src/services/campaign-rules.ts`: calling windows, the Indian
outer bound, retries, phone-number normalisation and CSV parsing.

A campaign the dialer can't serve is paused with a `statusReason` rather than
failing call after call. The reasons are no credit, no published agent
version, or a caller ID the organisation no longer holds. It stays paused
until someone resumes it.

## Billing

A call is priced by the control plane, not the worker. The worker reports what
it observed -- seconds of speech, characters synthesised, tokens in and out,
which models ran -- and the rate card here turns that into money. A pricing
change is then one deploy rather than a fleet rollout, and a worker on an older
build cannot quietly bill at last month's rates.

Cost and price are stored separately on every usage record: cost is what the
platform paid its providers, price is what the customer is charged. Margin per
call is wanted from the first week and cannot be reconstructed afterwards from
one blended figure.

`/internal/resolve` refuses an organisation with no credit, with a 402, before
the agent is handed over -- a refusal is only worth anything while it can still
prevent the spend. The response carries what is left so the worker can cap the
call's own ceiling to it.

The ledger is append-only and `org_balances` is a cache of it, moved only in the
same transaction as the entry that justifies it. `recomputeBalance` rebuilds one
from the entries, which is how the cache is checked and repaired.

An unpriced model flags the usage record for review rather than discarding it.
Losing a row is revenue that silently never existed; a flagged row can be
repriced once the card catches up.

## Validating an agent configuration

```bash
bun test                  # includes the cross-language agreement tests
bun run schema:check      # fails if the shared schema has drifted
```

`validateAgentConfig` enforces the same rules the worker does, from
`packages/shared/agent-config.schema.json`. That file is generated from the
worker's pydantic model; see
[packages/shared/README.md](../../packages/shared/README.md) for why the rules
live there and how the two sides are kept honest.

The short version: the valid models and voices come from the Sarvam plugin's
own tables, which the API cannot import without installing the entire voice
stack. So they are exported, and `src/db/agreement.test.ts` runs both
validators over the same configurations and fails if they ever disagree.

## Changing the schema

Edit the tables in `src/db/schema/`, then:

```bash
bun run db:generate       # writes a new migration to drizzle/
bun run db:migrate
```

Migrations are generated, reviewed and committed. `drizzle-kit push` is not
wired up on purpose: it applies a schema straight to a database with no
artefact in the repository, which is how a production schema quietly stops
matching what the code says it is.

Two migrations are hand-written, and regenerating will not touch them:

- `0000_extensions.sql` creates `citext`, which drizzle-kit emits a column for
  but not the extension itself, so a generated migration alone fails on a
  fresh database.
- `0002_agent_version_pointers.sql` adds the foreign keys between `agents` and
  `agent_versions`. The two tables reference each other, so one has to exist
  before the constraints can be added.

## What the schema is built around

**Agent versions are immutable.** An agent is a name and two pointers, one to
the draft being edited and one to the version that calls actually run.
Publishing writes a new version and moves a pointer; nothing is edited in
place. A call pins its version id at the start, so editing a prompt cannot
change a conversation that is already happening, and every call record names
the exact configuration that produced it.

**Writes are idempotent on explicit keys.** `calls.lk_job_id`,
`call_events (call_id, seq)` and `usage_records.idempotency_key` are all
unique. Workers get killed by deploys, jobs get retried and webhooks get
redelivered; a forked call record is a billing error and a duplicated usage
record is a customer charged twice.

**Cost and price are separate columns.** Cost is what the platform paid its
providers; price is what the customer is charged. Margin per call is wanted
from the first week and cannot be reconstructed later from a blended figure.

**The ledger is append-only.** `org_balances` is a cache of it, updated only in
the same transaction as the entry that justifies it, and always rebuildable by
summing the ledger.
