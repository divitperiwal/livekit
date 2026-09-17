# apps/

The control plane and the dashboard. Neither exists yet.

- `api/` — Bun backend. Owns Postgres and its migrations, authentication,
  organisations, agents, phone numbers, billing, LiveKit SIP provisioning and
  the LiveKit webhook receiver. It is also what the worker asks for an agent's
  configuration at the start of a call, and what the worker posts transcripts
  and usage back to.
- `web/` — Next.js dashboard, against that API.

These are scaffolded in the next phase, once there is a schema for them to be
built against. Standing them up earlier would mean guessing at the shape of
endpoints the data model has not settled yet.

The Python worker in `worker/` is deliberately independent of both: it holds no
database credentials and owns no schema, so it can be developed and run against
environment variables until the API is ready to answer.
