/**
 * The internal API over HTTP, including its cache.
 *
 * `resolution.test.ts` covers the queries directly. These tests go through the
 * route, because the bug worth guarding here lives between the two: the cache
 * is keyed on what is being looked up, not on who is asking, so an ownership
 * check placed inside the loader holds on a cache miss and lapses on a hit.
 *
 * That is a nastier failure than no check at all -- it passes every test that
 * starts from a cold cache, and only misbehaves in production once the entry
 * is warm.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis, redis } from "../cache";
import { createClient } from "../db/client";
import { agents, agentVersions, orgBalances, orgs } from "../db/schema";
import type { ResolvedAgent } from "../services/agent-resolution";
import { internalRoutes } from "./internal";

const { sql, db } = createClient({ max: 2 });
const app = internalRoutes(db);

const fixture = { orgA: "", orgB: "", agentA: "", versionA: "" };

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 8);

  const orgA = (
    await db.insert(orgs).values({ name: "A", slug: `a-${suffix}` }).returning()
  )[0]!;
  const orgB = (
    await db.insert(orgs).values({ name: "B", slug: `b-${suffix}` }).returning()
  )[0]!;

  const agent = (
    await db
      .insert(agents)
      .values({ orgId: orgA.id, name: "A", slug: `agent-${suffix}` })
      .returning()
  )[0]!;

  const version = (
    await db
      .insert(agentVersions)
      .values({
        agentId: agent.id,
        orgId: orgA.id,
        version: 1,
        promptMode: "verbatim",
        instructions: "Prompt",
        greeting: "Hello",
        config: {},
        publishedAt: new Date(),
      })
      .returning()
  )[0]!;

  await db.update(agents).set({ liveVersionId: version.id }).where(eq(agents.id, agent.id));

  // Resolution refuses an organisation that cannot pay, so both need funding
  // for these tests to be about routing rather than about credit.
  for (const id of [orgA.id, orgB.id]) {
    await db
      .insert(orgBalances)
      .values({ orgId: id, balanceInr: "1000" })
      .onConflictDoNothing();
  }

  Object.assign(fixture, {
    orgA: orgA.id,
    orgB: orgB.id,
    agentA: agent.id,
    versionA: version.id,
  });

  // Start from a cold cache so the warming below is the test's own doing.
  try {
    await redis().del(`agentlive:${agent.id}`, `agentcfg:${version.id}`);
  } catch {
    /* the cache being unavailable is fine; resolution falls through */
  }
});

afterAll(async () => {
  for (const id of [fixture.orgA, fixture.orgB]) {
    await db.delete(orgs).where(eq(orgs.id, id));
  }
  await Promise.allSettled([sql.end(), closeRedis()]);
});

function get(path: string) {
  return app.request(`http://internal${path}`);
}

describe("resolve", () => {
  test("by agent id", async () => {
    const response = await get(`/resolve?agentId=${fixture.agentA}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ResolvedAgent;
    expect(body.agentVersionId).toBe(fixture.versionA);
    expect(body.promptMode).toBe("verbatim");
  });

  test("by version id", async () => {
    const response = await get(`/resolve?agentVersionId=${fixture.versionA}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ResolvedAgent).orgId).toBe(fixture.orgA);
  });

  test("needs something to resolve by", async () => {
    expect((await get("/resolve")).status).toBe(400);
  });

  test("an unknown agent is not found", async () => {
    const response = await get(
      "/resolve?agentId=00000000-0000-0000-0000-000000000000",
    );
    expect(response.status).toBe(404);
  });
});

describe("the ownership check survives a warm cache", () => {
  test("agent lookup, warmed then forged", async () => {
    // Warm it with a request that is entirely legitimate.
    expect((await get(`/resolve?agentId=${fixture.agentA}`)).status).toBe(200);

    // Now claim it belongs to someone else. Before the fix this was served
    // from the cache with a 200, handing one tenant another tenant's prompt.
    const forged = await get(
      `/resolve?agentId=${fixture.agentA}&orgId=${fixture.orgB}`,
    );
    expect(forged.status).toBe(403);
  });

  test("version lookup, warmed then forged", async () => {
    expect((await get(`/resolve?agentVersionId=${fixture.versionA}`)).status).toBe(200);

    const forged = await get(
      `/resolve?agentVersionId=${fixture.versionA}&orgId=${fixture.orgB}`,
    );
    expect(forged.status).toBe(403);
  });

  test("the owning org is still allowed after a forged attempt", async () => {
    // A refusal must not poison the entry for the tenant it belongs to.
    await get(`/resolve?agentId=${fixture.agentA}&orgId=${fixture.orgB}`);
    const legitimate = await get(
      `/resolve?agentId=${fixture.agentA}&orgId=${fixture.orgA}`,
    );
    expect(legitimate.status).toBe(200);
  });
});

describe("an organisation that cannot pay is refused", () => {
  test("resolution returns 402 when the balance is exhausted", async () => {
    // Checked before the agent is handed over, because a refusal is only worth
    // anything while it can still prevent the spend.
    await db
      .update(orgBalances)
      .set({ balanceInr: "0", creditLimitInr: "0" })
      .where(eq(orgBalances.orgId, fixture.orgA));
    try {
      const response = await get(`/resolve?agentId=${fixture.agentA}`);
      expect(response.status).toBe(402);
    } finally {
      await db
        .update(orgBalances)
        .set({ balanceInr: "1000" })
        .where(eq(orgBalances.orgId, fixture.orgA));
    }
  });

  test("a funded organisation is told what is left", async () => {
    // So the worker can cap the call's own ceiling to the remaining balance.
    const response = await get(`/resolve?agentVersionId=${fixture.versionA}`);
    const body = (await response.json()) as { availableInr: number };
    expect(body.availableInr).toBeGreaterThan(0);
  });
});
