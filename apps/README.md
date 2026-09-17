# apps/

- `api/` — Bun control plane. Owns Postgres and its migrations, and will own
  authentication, organisations, agents, phone numbers, billing, LiveKit SIP
  provisioning and the LiveKit webhook receiver. It is also what the worker
  asks for an agent's configuration at the start of a call, and what the worker
  posts transcripts and usage back to.

  Currently the schema and its migrations; the HTTP server is next.

- `web/` — Next.js dashboard, against that API. Not started. Building it before
  the endpoints exist would mean guessing at their shape.

The Python worker in `../worker/` stays independent of both: it holds no
database credentials and owns no schema, so it can be run against environment
variables until the API is ready to answer.
