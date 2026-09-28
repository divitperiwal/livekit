/**
 * Playing recordings back, and deleting them when their time is up.
 *
 * The worker writes recordings (see its `recording.py`); the control plane
 * only reads and deletes them, so it can run with credentials that cannot
 * write. The same `RECORDING_S3_*` variables configure both.
 *
 * Playback is a presigned URL that expires in minutes, generated each time
 * someone asks. The stored thing is the key, never a URL: a URL outlives its
 * purpose, ends up in logs and support tickets, and cannot be revoked.
 */

import { S3Client } from "bun";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { calls, orgs } from "../db/schema";

const PLAYBACK_SECONDS = 10 * 60;

let client: S3Client | null | undefined;

/** The bucket, or null when recording storage is not configured. */
export function recordingStore(): S3Client | null {
  if (client !== undefined) return client;
  const bucket = process.env.RECORDING_S3_BUCKET;
  const accessKeyId = process.env.RECORDING_S3_ACCESS_KEY;
  const secretAccessKey = process.env.RECORDING_S3_SECRET_KEY;
  client =
    bucket && accessKeyId && secretAccessKey
      ? new S3Client({
          bucket,
          accessKeyId,
          secretAccessKey,
          region: process.env.RECORDING_S3_REGION || "auto",
          endpoint: process.env.RECORDING_S3_ENDPOINT || undefined,
        })
      : null;
  return client;
}

/** A short-lived link to play one call's recording, scoped to its organisation. */
export async function playbackUrl(db: Database, orgId: string, callId: string): Promise<string | null> {
  const store = recordingStore();
  if (!store) return null;
  const row = (
    await db
      .select({ key: calls.recordingKey })
      .from(calls)
      .where(and(eq(calls.id, callId), eq(calls.orgId, orgId)))
      .limit(1)
  )[0];
  if (!row?.key) return null;
  return store.presign(row.key, { expiresIn: PLAYBACK_SECONDS, method: "GET" });
}

/**
 * Deletes recordings older than their organisation keeps them.
 *
 * The object goes first and the key second: if the delete fails, the key
 * stays and the next sweep tries again, rather than forgetting a file that
 * still exists. Batched so one sweep cannot run for hours.
 */
export async function sweepExpiredRecordings(
  db: Database,
  now: Date = new Date(),
  store: Pick<S3Client, "delete"> | null = recordingStore(),
  batch = 200,
): Promise<number> {
  if (!store) return 0;
  const expired = await db
    .select({ id: calls.id, key: calls.recordingKey })
    .from(calls)
    .innerJoin(orgs, eq(orgs.id, calls.orgId))
    .where(
      and(
        isNotNull(calls.recordingKey),
        sql`${calls.endedAt} < ${now.toISOString()}::timestamptz - make_interval(days => ${orgs.recordingRetentionDays})`,
      ),
    )
    .limit(batch);

  let deleted = 0;
  for (const row of expired) {
    try {
      await store.delete(row.key!);
    } catch (error) {
      console.error(`recordings: could not delete ${row.key}: ${(error as Error).message}`);
      continue;
    }
    await db.update(calls).set({ recordingKey: null }).where(eq(calls.id, row.id));
    deleted += 1;
  }
  return deleted;
}
