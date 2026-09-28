/**
 * The background process: `bun run background`.
 *
 * Everything the platform does on a clock rather than in answer to a request:
 *
 * - the campaign dialer, every tick;
 * - webhook delivery, every tick;
 * - the stale-call sweeper, every minute -- a call whose worker died never
 *   finalises, and until it is swept its campaign contact holds a slot and
 *   its `call.ended` webhook never goes -- and the same for test runs;
 * - deleting recordings past their organisation's retention, hourly;
 * - pruning old webhook deliveries, daily.
 *
 * Separate from the API server so the two deploy and restart independently:
 * a deploy of the dashboard's API should not pause every campaign. More than
 * one may run at once. The dialer locks per campaign and webhook deliveries
 * are leased, so two processes never send the same thing.
 */

import { and, inArray, lt } from "drizzle-orm";

import { closeRedis } from "./cache";
import { createClient } from "./db/client";
import { evalRuns } from "./db/schema";
import { sweepStaleCalls } from "./services/calls";
import { dialTick, liveKitDispatcher } from "./services/dialer";
import { sweepExpiredRecordings } from "./services/recordings";
import { deliverDue, pruneDeliveries } from "./services/webhooks";

const TICK_MS = Number(process.env.DIALER_TICK_MS ?? 5000);

const { sql, db } = createClient();
const dispatcher = liveKitDispatcher();

/** A job that runs at most once per `everyMs`, and never twice at once. */
function every(everyMs: number, name: string, job: () => Promise<unknown>) {
  let last = 0;
  return async (now: number) => {
    if (now - last < everyMs) return;
    last = now;
    try {
      const result = await job();
      if (result) console.log(`${name}: ${JSON.stringify(result)}`);
    } catch (error) {
      // One failing job must not stop the others. Each is safe to repeat,
      // so the next run picks up whatever this one did not finish.
      console.error(`${name} failed`, error);
    }
  };
}

const quiet = (report: Record<string, number>) => (Object.values(report).some((n) => n > 0) ? report : null);

/**
 * Test runs a worker never finished. A run is dispatched and then only the
 * worker writes to it; one that died mid-run would otherwise show as running
 * forever.
 */
async function sweepStaleEvalRuns(): Promise<number> {
  const stale = await db
    .update(evalRuns)
    .set({ status: "failed", error: "no worker reported back within 30 minutes", finishedAt: new Date() })
    .where(and(inArray(evalRuns.status, ["queued", "running"]), lt(evalRuns.createdAt, new Date(Date.now() - 30 * 60_000))))
    .returning({ id: evalRuns.id });
  return stale.length;
}

const jobs = [
  every(60_000, "sweeper", async () => (await sweepStaleCalls(db)) || null),
  every(0, "dialer", async () => quiet({ ...(await dialTick(db, dispatcher)) })),
  every(0, "webhooks", async () => quiet({ ...(await deliverDue(db)) })),
  every(60_000, "eval-runs-swept", async () => (await sweepStaleEvalRuns()) || null),
  every(3600_000, "recordings", async () => (await sweepExpiredRecordings(db)) || null),
  every(24 * 3600_000, "deliveries-pruned", async () => (await pruneDeliveries(db, new Date())) || null),
];

let stopping = false;

async function run() {
  console.log(`background running, one tick every ${TICK_MS}ms`);
  while (!stopping) {
    const started = Date.now();
    for (const job of jobs) await job(started);
    await Bun.sleep(Math.max(0, TICK_MS - (Date.now() - started)));
  }
}

// Finish the tick in flight rather than abandoning a claim half-dispatched.
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

await run();
await Promise.allSettled([sql.end(), closeRedis()]);
process.exit(0);
