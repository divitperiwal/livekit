import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../../db/database";
import { calls, orgs } from "../../db/schema";

export type RecordingDeleter = (key: string) => Promise<void>;

/**
 * Deletes recordings older than their org's `recording_retention_days` (default 30) and
 * marks the call. Storage lifecycle rules are only the backstop. A failed delete is left
 * for the next pass; the call keeps its key until the object is gone.
 */
export async function deleteExpiredRecordings(
  db: Database,
  deleteRecording: RecordingDeleter,
  input: { now: Date; batchSize?: number },
) {
  const expired = await db
    .select({ id: calls.id, key: calls.recordingKey })
    .from(calls)
    .innerJoin(orgs, eq(orgs.id, calls.orgId))
    .where(
      and(
        isNotNull(calls.recordingKey),
        isNull(calls.recordingDeletedAt),
        lt(
          calls.endedAt,
          sql`${input.now.toISOString()}::timestamptz - make_interval(days => ${orgs.recordingRetentionDays})`,
        ),
      ),
    )
    .limit(input.batchSize ?? 100);

  let deleted = 0;
  let failed = 0;
  for (const recording of expired) {
    try {
      await deleteRecording(recording.key!);
      await db
        .update(calls)
        .set({ recordingDeletedAt: input.now })
        .where(eq(calls.id, recording.id));
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error(`could not delete recording ${recording.key}`, error);
    }
  }
  return { deleted, failed };
}
