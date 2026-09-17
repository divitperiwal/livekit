# @automitra/api

The control plane. Owns the database and everything that is not the live call:
organisations, users, agents, phone numbers, tools, call records and billing.

Right now it is the schema and its migrations. The HTTP server comes next,
along with the internal endpoints the worker calls to fetch an agent's
configuration and post transcripts and usage back.

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
