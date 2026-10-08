import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { calls, orgs } from "../../src/db/schema";
import { deleteExpiredRecordings } from "../../src/modules/calls/recording-retention";
import { createScenario } from "../http/scenario";

const NOW = new Date("2026-10-05T06:30:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);

async function callsWithRecordings(endedDaysAgo: number[]) {
  const scenario = await createScenario();
  const ids: string[] = [];
  for (const [i, days] of endedDaysAgo.entries()) {
    const { body } = await scenario.open();
    await scenario.db
      .update(calls)
      .set({
        recordingKey: `recordings/${scenario.ids.orgId}/2026/09/room-${i}.ogg`,
        endedAt: daysAgo(days),
      })
      .where(eq(calls.id, body.id));
    ids.push(body.id);
  }
  return { ...scenario, callIds: ids };
}

describe("recording retention", () => {
  test("deletes recordings past the org's retention and marks the call; newer ones stay", async () => {
    const { db, callIds } = await callsWithRecordings([31, 29]);
    const deleted: string[] = [];
    expect(
      await deleteExpiredRecordings(db, async (key) => void deleted.push(key), { now: NOW }),
    ).toEqual({ deleted: 1, failed: 0 });
    expect(deleted).toEqual([expect.stringContaining("room-0.ogg")]);
    const [old] = await db.select().from(calls).where(eq(calls.id, callIds[0]!));
    const [recent] = await db.select().from(calls).where(eq(calls.id, callIds[1]!));
    expect(old?.recordingDeletedAt).toEqual(NOW);
    expect(recent?.recordingDeletedAt).toBeNull();
    expect(
      await deleteExpiredRecordings(db, async (key) => void deleted.push(key), { now: NOW }),
    ).toEqual({ deleted: 0, failed: 0 });
  });

  test("an org's own retention applies", async () => {
    const { db, ids } = await callsWithRecordings([8]);
    await db.update(orgs).set({ recordingRetentionDays: 7 }).where(eq(orgs.id, ids.orgId));
    expect((await deleteExpiredRecordings(db, async () => {}, { now: NOW })).deleted).toBe(1);
  });

  test("a failed delete leaves the call marked as still holding its recording", async () => {
    const { db, callIds } = await callsWithRecordings([40]);
    const result = await deleteExpiredRecordings(
      db,
      async () => {
        throw new Error("spaces down");
      },
      { now: NOW },
    );
    expect(result).toEqual({ deleted: 0, failed: 1 });
    const [call] = await db.select().from(calls).where(eq(calls.id, callIds[0]!));
    expect(call?.recordingDeletedAt).toBeNull();
  });
});
