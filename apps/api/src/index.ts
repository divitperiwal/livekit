/**
 * The control plane's HTTP server.
 *
 * Three APIs with different trust models. `/internal` is what the worker
 * calls, authenticated by a shared secret on a private network and scoped to
 * nothing -- it serves any tenant. `/api` is what the dashboard calls,
 * authenticated by a session cookie and scoped to that session's
 * organisation. `/v1` is what customers' systems call, authenticated by an
 * API key and scoped to the key's organisation.
 */

import { Hono } from "hono";

import { closeRedis } from "./cache";
import { createClient } from "./db/client";
import { env } from "./env";
import { apiRoutes } from "./routes/api";
import { internalRoutes } from "./routes/internal";
import { publicRoutes } from "./routes/public";
import { secretsMatch } from "./services/auth";
import { liveKitDispatcher, type Dispatcher } from "./services/dialer";

const { sql, db } = createClient();
const app = new Hono();

app.get("/health", async (c) => {
  try {
    await sql`select 1`;
    return c.json({ status: "ok" });
  } catch (error) {
    // Report the failure without echoing a connection string.
    return c.json({ status: "degraded", database: "unreachable" }, 503);
  }
});

app.use("/internal/*", async (c, next) => {
  const presented = c.req.header("x-internal-secret");
  if (!presented || !secretsMatch(presented, env.internalApiSecret)) {
    return c.json({ error: "unauthorised" }, 401);
  }
  await next();
});

app.route("/internal", internalRoutes(db));

// The dashboard's API. Unlike /internal, every route below its own auth
// middleware is scoped to the signed-in session's organisation.
app.route("/api", apiRoutes(db));

// The public API, for customers' own systems. Authenticated by API key and
// scoped to the key's organisation. The dispatcher is made on first use, so
// an API without LiveKit credentials still serves everything else.
let dispatcher: Dispatcher | undefined;
app.route(
  "/v1",
  publicRoutes(db, () => (dispatcher ??= liveKitDispatcher())),
);

app.onError((error, c) => {
  // Postgres refusing a value's syntax -- almost always an id in the path
  // that is not a UUID. That is the request's mistake, not the server's, and
  // a 500 for it would page someone over a typo.
  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code === "22P02") return c.json({ error: "a value in the request is not in the expected form" }, 400);

  // Logged in full, returned in outline: an internal error message can carry
  // a query, a column name or a value, and this endpoint is reachable by
  // anything that has the secret.
  console.error(error);
  return c.json({ error: "internal error" }, 500);
});

const server = Bun.serve({ port: env.port, fetch: app.fetch });
console.log(`api listening on :${server.port}`);

async function shutdown() {
  await server.stop();
  await Promise.allSettled([sql.end(), closeRedis()]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
