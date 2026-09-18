# @automitra/web

The dashboard. Four screens: calls and their transcripts, agents, phone
numbers, and usage.

## Running it

The API and its database have to be up first:

```bash
docker compose up -d                     # from the repository root
cd apps/api && bun run dev               # :3000
```

Then here:

```bash
bun install
bun run dev                              # :3001 or the next free port
```

Sign in with the seeded account — `owner@kbsmotors.test`, password
`automitra-dev`, or whatever `SEED_PASSWORD` was set to. `bun run db:seed` in
`apps/api` creates it.

`API_URL` points at the control plane and defaults to `http://localhost:3000`.

## How it is put together

**Every read happens on the server.** Pages are React Server Components that
call the API with the browser's session cookie forwarded. The API is not
reachable from the public internet in a real deployment, and nothing about a
tenant's data reaches the client bundle except what a page chooses to render.

**The session cookie is httpOnly**, so no script can read it, and `SameSite=Lax`
so it does not ride along on cross-site requests. The login action copies the
cookie the API issues onto its own response, since the browser talks to Next
and Next talks to the API.

**`proxy.ts`, not `middleware.ts`** — the latter is deprecated in Next 16. It
only checks that a cookie is *present*, which is a redirect for convenience
rather than a security boundary; validating on every navigation would mean a
Redis round trip each time. The API checks properly on every request, so a
forged cookie reaches a page that then fails to load anything.

**The agent form's dropdowns come from the generated schema**, the same file
the API validates against. A voice list copied into the UI eventually offers a
value the worker rejects — and a dropdown is exactly where someone would assume
every option is valid. Switching the TTS model re-picks the speaker for the
same reason: the v2 roster was replaced wholesale in v3.

**Publishing never edits.** It writes a new version and moves a pointer, so a
call already running keeps the configuration it resolved and every past call
record still names what actually produced it.
