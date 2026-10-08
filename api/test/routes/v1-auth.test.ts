import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts } from "../../src/db/schema";
import { revokeApiKey, apiKeyLookupPrefix } from "../../src/modules/keys/api-keys";
import { createV1Scenario } from "../http/v1-scenario";

describe("/v1 authentication", () => {
  test("no key, a malformed key or an unknown key is 401", async () => {
    const { v1, key } = await createV1Scenario();
    expect((await v1(null, "GET", "/orgs")).status).toBe(401);
    expect((await v1("sk_live_whatever", "GET", "/orgs")).status).toBe(401);
    const tampered = key.slice(0, -4) + (key.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await v1(tampered, "GET", "/orgs")).status).toBe(401);
    expect((await v1(key, "GET", "/orgs")).status).toBe(200);
  });

  test("a revoked key stops working on the next request", async () => {
    const { v1, key, db } = await createV1Scenario();
    expect((await v1(key, "GET", "/orgs")).status).toBe(200);
    await revokeApiKey(db, apiKeyLookupPrefix(key));
    expect((await v1(key, "GET", "/orgs")).status).toBe(401);
  });

  test("an expired key is refused", async () => {
    const { v1, issue } = await createV1Scenario();
    const expired = await issue({ expiresAt: new Date("2026-01-01") });
    expect((await v1(expired, "GET", "/orgs")).status).toBe(401);
  });

  test("a suspended account's keys are refused", async () => {
    const { v1, key, db, account } = await createV1Scenario();
    await db.update(accounts).set({ status: "suspended" }).where(eq(accounts.id, account.id));
    expect(await v1(key, "GET", "/orgs")).toMatchObject({
      status: 403,
      body: { error: "account suspended" },
    });
  });

  test("a key without the scope is refused that route only", async () => {
    const { v1, issue, withOrgAndAgent } = await createV1Scenario();
    await withOrgAndAgent();
    const readOnly = await issue({ scopes: ["orgs:read", "calls:read"] });
    expect((await v1(readOnly, "GET", "/orgs/clinic-42")).status).toBe(200);
    expect((await v1(readOnly, "PUT", "/orgs/clinic-42", { name: "x" })).status).toBe(403);
    expect(
      (await v1(readOnly, "POST", "/orgs/clinic-42/calls", { agentId: "x", to: "+919876543210" }))
        .body.error,
    ).toContain("calls:write");
  });

  test("another account's org does not exist for this key", async () => {
    const { v1, issue, db, withOrgAndAgent } = await createV1Scenario();
    await withOrgAndAgent();
    const [other] = await db
      .insert(accounts)
      .values({ slug: "outside", name: "Outside" })
      .returning();
    const outsideKey = await issue({ accountId: other!.id });
    expect((await v1(outsideKey, "GET", "/orgs/clinic-42")).status).toBe(404);
    expect((await v1(outsideKey, "GET", "/orgs/clinic-42/agents")).status).toBe(404);
    expect((await v1(outsideKey, "GET", "/orgs")).body.orgs).toEqual([]);
  });

  test("past the per-key rate limit, 429 with Retry-After", async () => {
    const { v1, key, issue } = await createV1Scenario({ ratePerMinute: 2 });
    await v1(key, "GET", "/orgs");
    await v1(key, "GET", "/orgs");
    const limited = await v1(key, "GET", "/orgs");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await v1(await issue(), "GET", "/orgs")).status).toBe(200);
  });
});
