import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Database } from "../../db/database";
import { calls } from "../../db/schema";

/** Guarantee 15: a dispatch no worker took within this long frees its slot. */
export const LOST_DISPATCH_MS = 5 * 60_000;
/** After the longest call: upload (120 s) + analysis (45 s), with margin. */
export const POST_CALL_GRACE_MS = 5 * 60_000;

/**
 * Frees concurrency slots that would otherwise be held forever.
 * - A `queued` call no worker opened within 5 minutes was lost in dispatch: it is closed as
 *   failed (nothing was billed; nothing ran).
 * - A ringing / in-progress call past the longest possible call lost its worker: it is
 *   marked failed but left unfinalized, so a late finalize still records and bills it.
 */
export async function sweepStaleCalls(db: Database, input: { now: Date; maxCallSeconds: number }) {
  const { now } = input;
  const lostDispatches = await db
    .update(calls)
    .set({ status: "failed", endReason: "dispatch_lost", endedAt: now, finalizedAt: now })
    .where(
      and(
        eq(calls.status, "queued"),
        lt(calls.createdAt, new Date(now.getTime() - LOST_DISPATCH_MS)),
      ),
    )
    .returning({ id: calls.id });

  const abandonedBefore = new Date(
    now.getTime() - input.maxCallSeconds * 1000 - POST_CALL_GRACE_MS,
  );
  const lostWorkers = await db
    .update(calls)
    .set({ status: "failed", endReason: "worker_lost", endedAt: now })
    .where(
      and(
        inArray(calls.status, ["ringing", "in_progress"]),
        isNull(calls.finalizedAt),
        lt(calls.startedAt, abandonedBefore),
      ),
    )
    .returning({ id: calls.id });

  return { lostDispatches: lostDispatches.length, lostWorkers: lostWorkers.length };
}
