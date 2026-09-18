/**
 * The control plane's HTTP server.
 *
 * Two APIs with different trust models. `/internal` is what the worker calls,
 * authenticated by a shared secret on a private network and scoped to nothing
 * -- it serves any tenant. `/api` is what the dashboard calls, authenticated
 * by a session cookie and scoped to that session's organisation.
 */

import { Hono } from "hono";

import { closeRedis } from "./cache";
import { createClient } from "./db/client";
import { env } from "./env";
import { apiRoutes } from "./routes/api";
import { internalRoutes } from "./routes/internal";
import { secretsMatch } from "./services/auth";

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

app.onError((error, c) => {
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
