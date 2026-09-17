/**
 * Caching for the resolution path.
 *
 * This sits in front of the query a call makes before it can answer, so the
 * work it saves is work a caller would otherwise wait through.
 *
 * Two kinds of key, with deliberately different rules:
 *
 * `agentcfg:<versionId>` never needs invalidating. A version is immutable, so
 * a new one is a new key and the old entry simply expires unread. That is the
 * practical payoff of versioning agents rather than editing them.
 *
 * `agentlive:<agentId>` is the mutable one -- it points at whichever version
 * is currently live -- so it carries a short expiry and is dropped explicitly
 * when a version is published.
 */

import { Redis } from "ioredis";

import { env } from "./env";

/** Long, because the value behind it can never change. */
const CONFIG_TTL_SECONDS = 3600;
/** Short, because this pointer moves whenever someone publishes. */
const LIVE_POINTER_TTL_SECONDS = 30;

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) {
    client = new Redis(env.redisUrl, {
      // A call must not wait on a struggling cache. Failing fast here means
      // falling through to Postgres, which is correct but slower; hanging
      // would mean dead air on an answered call.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    // Without a handler, a connection error is an unhandled 'error' event and
    // takes the process down -- turning a degraded cache into an outage.
    client.on("error", (error) => {
      console.warn(`redis: ${error.message}`);
    });
    void client.connect().catch(() => {
      /* reported by the error handler above */
    });
  }
  return client;
}

/** Reads through the cache, falling back to `load` on a miss or any failure. */
async function through<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await redis().get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // A cache that is down must not break resolution.
  }

  const value = await load();

  try {
    await redis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* not worth failing the request over */
  }
  return value;
}

export function cachedVersion<T>(versionId: string, load: () => Promise<T>) {
  return through(`agentcfg:${versionId}`, CONFIG_TTL_SECONDS, load);
}

export function cachedLiveVersion<T>(agentId: string, load: () => Promise<T>) {
  return through(`agentlive:${agentId}`, LIVE_POINTER_TTL_SECONDS, load);
}

/** Drops an agent's live pointer. Called when a new version is published. */
export async function invalidateAgent(agentId: string): Promise<void> {
  try {
    await redis().del(`agentlive:${agentId}`);
  } catch {
    // The pointer expires on its own within seconds, so a failure here delays
    // a publish taking effect rather than losing it.
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = undefined;
  }
}
