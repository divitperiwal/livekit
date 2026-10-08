import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../src/db/database";
import { calls } from "../../src/db/schema";
import { withCallSlot } from "../../src/modules/calls/call-slots";
import { seedAccount, seedAgentWithVersion, seedApiKey, seedOrg } from "../db/seed";
import { createTestDatabase } from "../db/test-database";

async function keyWithLimit(maxConcurrentCalls: number) {
  const { db } = await createTestDatabase();
  const account = await seedAccount(db);
  const org = await seedOrg(db, account.id);
  const { agent, version } = await seedAgentWithVersion(db, org.id);
  const key = await seedApiKey(db, account.id, maxConcurrentCalls);
  const callBase = { orgId: org.id, agentId: agent.id, agentVersionId: version.id };

  const insertQueuedCall = (apiKeyId: string) => async (tx: DatabaseTransaction) => {
    const [call] = await tx
      .insert(calls)
      .values({
        ...callBase,
        apiKeyId,
        direction: "outbound",
        status: "queued",
        requestId: crypto.randomUUID(),
      })
      .returning();
    return call!;
  };
  const placeCall = (apiKeyId = key.id) => withCallSlot(db, apiKeyId, insertQueuedCall(apiKeyId));

  return { db, account, key, callBase, placeCall };
}

describe("per-key call concurrency", () => {
  test("a key places calls up to its limit and is refused past it", async () => {
    const { placeCall } = await keyWithLimit(2);
    expect((await placeCall()).ok).toBe(true);
    expect((await placeCall()).ok).toBe(true);
    expect(await placeCall()).toEqual({
      ok: false,
      reason: "concurrency_limit",
      maxConcurrentCalls: 2,
      liveCalls: 2,
    });
  });

  test("a call that ends frees its slot", async () => {
    const { db, placeCall } = await keyWithLimit(1);
    const first = await placeCall();
    if (!first.ok) throw new Error("first call refused");
    expect((await placeCall()).ok).toBe(false);

    await db
      .update(calls)
      .set({ status: "completed", lkJobId: "job-1" })
      .where(eq(calls.id, first.value.id));
    expect((await placeCall()).ok).toBe(true);
  });

  test("ringing and in-progress calls hold slots too", async () => {
    const { db, placeCall } = await keyWithLimit(1);
    const first = await placeCall();
    if (!first.ok) throw new Error("first call refused");
    await db
      .update(calls)
      .set({ status: "in_progress", lkJobId: "job-1" })
      .where(eq(calls.id, first.value.id));
    expect((await placeCall()).ok).toBe(false);
  });

  test("each key has its own limit", async () => {
    const { db, account, placeCall } = await keyWithLimit(1);
    const otherKey = await seedApiKey(db, account.id, 1);
    expect((await placeCall()).ok).toBe(true);
    expect((await placeCall(otherKey.id)).ok).toBe(true);
  });

  test("inbound calls, which no key placed, take no key's slot", async () => {
    const { db, callBase, placeCall } = await keyWithLimit(1);
    await db
      .insert(calls)
      .values({ ...callBase, direction: "inbound", status: "in_progress", lkJobId: "job-in" });
    expect((await placeCall()).ok).toBe(true);
  });

  test("simultaneous requests never exceed the limit", async () => {
    const { placeCall } = await keyWithLimit(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => placeCall()));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
  });
});
