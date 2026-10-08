import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { calls, usageRecords } from "../../src/db/schema";
import { withCallSlot } from "../../src/modules/calls/call-slots";
import { sweepStaleCalls } from "../../src/modules/calls/sweep-stale-calls";
import { createScenario } from "../http/scenario";
import { seedApiKey } from "../db/seed";

const T0 = new Date("2026-10-05T06:30:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** API half: the worker never retries an unreachable number (its own test); this is the slot. */
describe("guarantee 15: a lost dispatch frees its slot after 5 minutes", () => {
  async function keyWithOneQueuedCall() {
    const scenario = await createScenario();
    const key = await seedApiKey(scenario.db, scenario.ids.accountId, 1);
    const queue = () =>
      withCallSlot(scenario.db, key.id, async (tx) => {
        const id = crypto.randomUUID();
        await tx.insert(calls).values({
          id,
          requestId: id,
          apiKeyId: key.id,
          orgId: scenario.ids.orgId,
          agentId: scenario.ids.agentId,
          agentVersionId: scenario.ids.agentVersionId,
          direction: "outbound",
          status: "queued",
          createdAt: T0,
        });
        return id;
      });
    const first = await queue();
    return { ...scenario, queue, firstId: first.ok ? first.value : "" };
  }

  test("before 5 minutes the slot is held; after, the call fails and the slot is free", async () => {
    const { db, queue, firstId } = await keyWithOneQueuedCall();
    expect((await queue()).ok).toBe(false);

    expect(await sweepStaleCalls(db, { now: minutes(4), maxCallSeconds: 600 })).toEqual({
      lostDispatches: 0,
      lostWorkers: 0,
    });
    expect((await queue()).ok).toBe(false);

    expect(
      (await sweepStaleCalls(db, { now: minutes(6), maxCallSeconds: 600 })).lostDispatches,
    ).toBe(1);
    const [lost] = await db.select().from(calls).where(eq(calls.id, firstId));
    expect(lost).toMatchObject({ status: "failed", endReason: "dispatch_lost" });
    expect((await queue()).ok).toBe(true);
  });
});

describe("a call whose worker vanished", () => {
  test("is failed after the longest call plus post-call time, and a late finalize still bills it", async () => {
    const { db, open, finalize } = await createScenario();
    const { body } = await open();
    await db.update(calls).set({ startedAt: T0 }).where(eq(calls.id, body.id));

    expect((await sweepStaleCalls(db, { now: minutes(14), maxCallSeconds: 600 })).lostWorkers).toBe(
      0,
    );
    expect((await sweepStaleCalls(db, { now: minutes(16), maxCallSeconds: 600 })).lostWorkers).toBe(
      1,
    );
    const [swept] = await db.select().from(calls).where(eq(calls.id, body.id));
    expect(swept).toMatchObject({ status: "failed", endReason: "worker_lost", finalizedAt: null });

    await finalize(body.id);
    expect(await db.$count(usageRecords, eq(usageRecords.callId, body.id))).toBe(1);
    const [finalized] = await db.select().from(calls).where(eq(calls.id, body.id));
    expect(finalized?.status).toBe("completed");
  });
});
