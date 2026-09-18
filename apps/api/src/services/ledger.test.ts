/**
 * The ledger, against a real database.
 *
 * The property worth holding above all others: the cached balance equals the
 * sum of the entries. If those ever disagree, every invoice is suspect and
 * there is no way to tell which one is right.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createClient } from "../db/client";
import { finalizeCall, startCall } from "./calls";
import { post, recomputeBalance, standing } from "./ledger";
import { agents, agentVersions, ledgerEntries, orgBalances, orgs } from "../db/schema";

const { sql, db } = createClient({ max: 2 });

let orgId = "";
let agentId = "";
let versionId = "";
const created: string[] = [];

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const org = (
    await db.insert(orgs).values({ name: "Ledger", slug: `ledger-${suffix}` }).returning()
  )[0]!;
  const agent = (
    await db
      .insert(agents)
      .values({ orgId: org.id, name: "A", slug: `a-${suffix}` })
      .returning()
  )[0]!;
  const version = (
    await db
      .insert(agentVersions)
      .values({
        agentId: agent.id,
        orgId: org.id,
        version: 1,
        instructions: "p",
        greeting: "g",
        config: {},
        publishedAt: new Date(),
      })
      .returning()
  )[0]!;

  orgId = org.id;
  agentId = agent.id;
  versionId = version.id;
  created.push(org.id);
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(orgs).where(eq(orgs.id, id)).catch(() => {});
  }
  await sql.end();
});

async function balance(): Promise<number> {
  const rows = await db
    .select()
    .from(orgBalances)
    .where(eq(orgBalances.orgId, orgId))
    .limit(1);
  return rows[0] ? Number(rows[0].balanceInr) : 0;
}

describe("posting entries", () => {
  test("a top-up raises the balance", async () => {
    await post(db, {
      orgId,
      kind: "topup",
      amountInr: 500,
      idempotencyKey: `topup:${orgId}:1`,
    });
    expect(await balance()).toBeCloseTo(500, 4);
  });

  test("usage lowers it", async () => {
    await post(db, { orgId, kind: "topup", amountInr: 100, idempotencyKey: `t:${orgId}` });
    await post(db, { orgId, kind: "usage", amountInr: -30, idempotencyKey: `u:${orgId}` });
    expect(await balance()).toBeCloseTo(70, 4);
  });

  test("the same key is applied once", async () => {
    // A retried finalize must not debit twice.
    const key = `once:${orgId}`;
    expect(await post(db, { orgId, kind: "usage", amountInr: -25, idempotencyKey: key })).toBe(true);
    expect(await post(db, { orgId, kind: "usage", amountInr: -25, idempotencyKey: key })).toBe(false);
    expect(await balance()).toBeCloseTo(-25, 4);
  });

  test("the balance always equals the sum of the entries", async () => {
    // The cache exists so a call start is one indexed read rather than a sum
    // over every entry. This is the invariant that makes it trustworthy.
    const amounts = [500, -12.5, -3.25, 200, -88.125, -0.001];
    for (const [index, amount] of amounts.entries()) {
      await post(db, {
        orgId,
        kind: amount > 0 ? "topup" : "usage",
        amountInr: amount,
        idempotencyKey: `mix:${orgId}:${index}`,
      });
    }

    const expected = amounts.reduce((sum, a) => sum + a, 0);
    expect(await balance()).toBeCloseTo(expected, 4);

    // And recomputing from the ledger agrees with the cache.
    expect(await recomputeBalance(db, orgId)).toBeCloseTo(expected, 4);
  });

  test("entries are never rewritten", async () => {
    const key = `immutable:${orgId}`;
    await post(db, { orgId, kind: "usage", amountInr: -10, idempotencyKey: key });
    await post(db, { orgId, kind: "usage", amountInr: -999, idempotencyKey: key });

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amountInr)).toBeCloseTo(-10, 4);
  });
});

describe("whether an organisation may place a call", () => {
  test("a funded organisation may", async () => {
    await post(db, { orgId, kind: "topup", amountInr: 100, idempotencyKey: `f:${orgId}` });
    const s = await standing(db, orgId);
    expect(s.canPlaceCalls).toBe(true);
    expect(s.availableInr).toBeCloseTo(100, 4);
  });

  test("an unfunded one may not", async () => {
    // No row means nobody has funded it. Read as no money rather than no
    // limit: the safe reading of missing data is the conservative one.
    const s = await standing(db, orgId);
    expect(s.canPlaceCalls).toBe(false);
    expect(s.availableInr).toBe(0);
  });

  test("an overdrawn one may not", async () => {
    await post(db, { orgId, kind: "usage", amountInr: -5, idempotencyKey: `o:${orgId}` });
    expect((await standing(db, orgId)).canPlaceCalls).toBe(false);
  });

  test("a credit limit allows going negative", async () => {
    await db
      .insert(orgBalances)
      .values({ orgId, balanceInr: "-50", creditLimitInr: "200" })
      .onConflictDoUpdate({
        target: orgBalances.orgId,
        set: { balanceInr: "-50", creditLimitInr: "200" },
      });

    const s = await standing(db, orgId);
    expect(s.canPlaceCalls).toBe(true);
    expect(s.availableInr).toBeCloseTo(150, 4);
  });
});

describe("a finalized call charges once", () => {
  test("the second finalize does not debit again", async () => {
    await post(db, { orgId, kind: "topup", amountInr: 1000, idempotencyKey: `seed:${orgId}` });
    const before = await balance();

    const call = await startCall(db, {
      orgId,
      agentId,
      agentVersionId: versionId,
      lkRoomName: "r",
      lkJobId: `JOB_${Math.random().toString(36).slice(2, 10)}`,
      direction: "inbound",
    });

    const usage = {
      sttSeconds: 60,
      ttsCharacters: 1000,
      llmPromptTokens: 10_000,
      llmCachedTokens: 0,
      llmCompletionTokens: 500,
      sttModel: "saaras:v4",
      ttsModel: "bulbul:v3",
      llmModel: "sarvam-105b-conversations",
    };

    await finalizeCall(db, call.id, { status: "completed", durationSeconds: 60, usage });
    const afterFirst = await balance();
    expect(afterFirst).toBeLessThan(before);

    // Both the close handler and the shutdown callback can fire.
    await finalizeCall(db, call.id, { status: "completed", durationSeconds: 60, usage });
    expect(await balance()).toBeCloseTo(afterFirst, 4);
  });

  test("the charge matches the price on the usage record", async () => {
    await post(db, { orgId, kind: "topup", amountInr: 1000, idempotencyKey: `seed2:${orgId}` });
    const before = await balance();

    const call = await startCall(db, {
      orgId,
      agentId,
      agentVersionId: versionId,
      lkRoomName: "r",
      lkJobId: `JOB_${Math.random().toString(36).slice(2, 10)}`,
      direction: "inbound",
    });

    await finalizeCall(db, call.id, {
      status: "completed",
      durationSeconds: 120,
      usage: {
        sttSeconds: 120,
        ttsCharacters: 2000,
        llmPromptTokens: 20_000,
        llmCachedTokens: 5000,
        llmCompletionTokens: 1000,
        sttModel: "saaras:v4",
        ttsModel: "bulbul:v3",
        llmModel: "sarvam-105b-conversations",
      },
    });

    const record = await db.query.usageRecords.findFirst({
      where: (u, { eq: is }) => is(u.callId, call.id),
    });
    expect(record?.priceInr).not.toBeNull();

    const charged = before - (await balance());
    expect(charged).toBeCloseTo(Number(record!.priceInr), 4);
  });
});
