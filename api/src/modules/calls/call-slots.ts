import { and, count, eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db/database";
import { apiKeys, calls, liveCallStatuses } from "../../db/schema";

export type CallSlotResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "concurrency_limit"; maxConcurrentCalls: number; liveCalls: number };

/**
 * Takes one of the key's concurrency slots by running `createQueuedCall` (which must
 * insert the call row with this `apiKeyId`) only while the key is under its limit.
 * The key's row is locked for the count, so two requests cannot both take the last slot.
 * Dispatch to LiveKit happens after this commits; a failed dispatch ends the call,
 * which frees the slot.
 */
export async function withCallSlot<T>(
  db: Database,
  apiKeyId: string,
  createQueuedCall: (tx: DatabaseTransaction) => Promise<T>,
): Promise<CallSlotResult<T>> {
  return db.transaction(async (tx) => {
    const [key] = await tx
      .select({ maxConcurrentCalls: apiKeys.maxConcurrentCalls })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .for("update");
    if (!key) throw new Error(`api key ${apiKeyId} not found`);

    const [live] = await tx
      .select({ liveCalls: count() })
      .from(calls)
      .where(and(eq(calls.apiKeyId, apiKeyId), inArray(calls.status, [...liveCallStatuses])));
    const liveCalls = live?.liveCalls ?? 0;

    if (liveCalls >= key.maxConcurrentCalls) {
      return {
        ok: false,
        reason: "concurrency_limit",
        maxConcurrentCalls: key.maxConcurrentCalls,
        liveCalls,
      };
    }
    return { ok: true, value: await createQueuedCall(tx) };
  });
}
