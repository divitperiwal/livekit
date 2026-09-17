/**
 * The control plane's HTTP server.
 *
 * Only the internal API so far -- the endpoints the worker calls to resolve an
 * agent and to record what a call did. The public API and the dashboard come
 * later.
 */

import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import { closeRedis } from "./cache";
import { createClient } from "./db/client";
import { env } from "./env";
import { internalRoutes } from "./routes/internal";

const { sql, db } = createClient();
const app = new Hono();

/**
 * Compares secrets without leaking their contents through timing.
 *
 * A plain `===` returns as soon as two bytes differ, so the time it takes
 * reveals how much of a guess was right, and a secret can be recovered a byte
 * at a time. Lengths are compared first because the constant-time comparison
 * needs equal-length buffers -- that leaks the length, which is not worth
 * protecting.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
