/**
 * Tools, campaigns and the do-not-call list, over HTTP.
 *
 * Mostly isolation again: a tool carries a customer's credentials to their
 * CRM, and a campaign decides whose phone rings, so neither may be reachable
 * -- read, attached, started -- from another organisation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import { agents, agentVersions, orgBalances, orgMembers, orgs, phoneNumbers, users } from "../db/schema";
import { apiRoutes } from "./api";
import { internalRoutes } from "./internal";

process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");

const { sql, db } = createClient({ max: 2 });
const app = apiRoutes(db);
const internal = internalRoutes(db);

const PASSWORD = "test-password-1234";
const fx = {
  orgA: "", orgB: "",
  agentA: "", agentB: "",
  numberA: "", numberB: "",
  emailA: "", emailB: "",
  cookieA: "", cookieB: "",
};

async function login(email: string): Promise<string> {
  const response = await app.request("http://api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function as(cookie: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return app.request(`http://api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });

  for (const key of ["A", "B"] as const) {
    const lower = key.toLowerCase();
    const org = (await db.insert(orgs).values({ name: `Org ${key}`, slug: `out-${lower}-${suffix}` }).returning())[0]!;
    const email = `out-${lower}-${suffix}@test.local`;
    const user = (await db.insert(users).values({ email, passwordHash: hash }).returning())[0]!;
    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
    await db.insert(orgBalances).values({ orgId: org.id, balanceInr: "500" });

    const agent = (
      await db.insert(agents).values({ orgId: org.id, name: `Agent ${key}`, slug: `agent-${lower}-${suffix}` }).returning()
    )[0]!;
    const version = (
      await db
        .insert(agentVersions)
        .values({ agentId: agent.id, orgId: org.id, version: 1, instructions: "p", greeting: "g", config: {}, publishedAt: new Date() })
        .returning()
    )[0]!;
    await db.update(agents).set({ liveVersionId: version.id }).where(eq(agents.id, agent.id));

    const number = (
      await db
        .insert(phoneNumbers)
        .values({
          orgId: org.id,
          e164: `+9156${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
          status: "assigned",
        })
        .returning()
    )[0]!;

    fx[`org${key}`] = org.id;
    fx[`agent${key}`] = agent.id;
    fx[`number${key}`] = number.id;
    fx[`email${key}`] = email;
  }

  fx.cookieA = await login(fx.emailA);
  fx.cookieB = await login(fx.emailB);
});

afterAll(async () => {
  for (const id of [fx.orgA, fx.orgB]) await db.delete(orgs).where(eq(orgs.id, id)).catch(() => {});
  for (const email of [fx.emailA, fx.emailB]) await db.delete(users).where(eq(users.email, email)).catch(() => {});
  await Promise.allSettled([sql.end(), closeRedis()]);
});

const TOOL = {
  name: "lookup_order",
  description: "Look up an order by its id",
  url: "https://crm.example.com/orders",
  parametersSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  authType: "bearer",
  authSecret: "sk_live_do_not_leak",
};

describe("tools", () => {
  let toolId = "";

  test("creating one never echoes its secret", async () => {
    const response = await as(fx.cookieA, "/tools", TOOL);
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("sk_live_do_not_leak");
    const { tool } = JSON.parse(text) as { tool: { id: string; hasSecret: boolean } };
    expect(tool.hasSecret).toBe(true);
    toolId = tool.id;
  });

  test("listing never shows the secret either", async () => {
    const text = await (await as(fx.cookieA, "/tools")).text();
    expect(text).toContain("lookup_order");
    expect(text).not.toContain("sk_live_do_not_leak");
    expect(text).not.toContain("authSecretCiphertext");
  });

  test("a duplicate name is refused", async () => {
    expect((await as(fx.cookieA, "/tools", TOOL)).status).toBe(409);
  });

  test("an unsafe URL is refused at the point of saving", async () => {
    const response = await as(fx.cookieA, "/tools", { ...TOOL, name: "meta", url: "https://169.254.169.254/" });
    expect(response.status).toBe(422);
  });

  test("another organisation cannot see or edit it", async () => {
    expect(await (await as(fx.cookieB, "/tools")).text()).not.toContain("lookup_order");
    expect((await as(fx.cookieB, `/tools/${toolId}`, { enabled: false }, "PATCH")).status).toBe(404);
  });

  test("another organisation cannot attach it to its own agent", async () => {
    const response = await as(fx.cookieB, `/agents/${fx.agentB}/versions`, {
      instructions: "p",
      greeting: "g",
      config: {},
      toolIds: [toolId],
    });
    expect(response.status).toBe(422);
  });

  test("publishing with tools, then without naming them, keeps them", async () => {
    const first = await as(fx.cookieA, `/agents/${fx.agentA}/versions`, {
      instructions: "p", greeting: "g", config: {}, toolIds: [toolId],
    });
    expect(first.status).toBe(200);

    // A prompt edit that says nothing about tools must not drop them.
    await as(fx.cookieA, `/agents/${fx.agentA}/versions`, { instructions: "p2", greeting: "g", config: {} });
    const detail = (await (await as(fx.cookieA, `/agents/${fx.agentA}`)).json()) as { toolIds: string[] };
    expect(detail.toolIds).toEqual([toolId]);
  });

  test("the worker receives the tool with its secret decrypted, and nobody else does", async () => {
    const response = await internal.request(`http://internal/resolve?agentId=${fx.agentA}`);
    const body = (await response.json()) as { tools: Array<{ name: string; authSecret: string }> };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ name: "lookup_order", authSecret: "sk_live_do_not_leak" });
  });

  test("a disabled tool is not handed to the worker", async () => {
    await as(fx.cookieA, `/tools/${toolId}`, { enabled: false }, "PATCH");
    const body = (await (await internal.request(`http://internal/resolve?agentId=${fx.agentA}`)).json()) as {
      tools: unknown[];
    };
    expect(body.tools).toHaveLength(0);
  });
});

describe("campaigns", () => {
  let campaignId = "";

  test("cannot be created against another organisation's agent or number", async () => {
    expect((await as(fx.cookieB, "/campaigns", { name: "x", agentId: fx.agentA })).status).toBe(422);
    expect(
      (await as(fx.cookieB, "/campaigns", { name: "x", agentId: fx.agentB, fromNumberId: fx.numberA })).status,
    ).toBe(422);
  });

  test("created as a draft", async () => {
    const response = await as(fx.cookieA, "/campaigns", { name: "Renewals", agentId: fx.agentA });
    expect(response.status).toBe(201);
    const { campaign } = (await response.json()) as { campaign: { id: string; status: string } };
    expect(campaign.status).toBe("draft");
    campaignId = campaign.id;
  });

  test("will not start without a number to call from", async () => {
    await as(fx.cookieA, `/campaigns/${campaignId}/contacts`, { csv: "phone\n9876543210" });
    const response = await as(fx.cookieA, `/campaigns/${campaignId}/start`, {});
    expect(response.status).toBe(422);
  });

  test("takes contacts as CSV, reporting duplicates, bad rows and suppressed numbers", async () => {
    await as(fx.cookieA, "/suppressions", { numbers: ["98765 00000"], reason: "asked by email" });

    const response = await as(fx.cookieA, `/campaigns/${campaignId}/contacts`, {
      csv: "name,phone\nAsha,9876543210\nRavi,98765-43211\nBad,12\nBlocked,9876500000\nRavi again,9876543211\n",
    });
    const result = (await response.json()) as {
      added: number; duplicates: number; suppressed: number; rejected: number;
    };
    // 9876543210 was already added by the previous test.
    expect(result).toMatchObject({ added: 2, duplicates: 2, suppressed: 1, rejected: 1 });
  });

  test("starts once it has a caller ID, and pauses", async () => {
    await as(fx.cookieA, `/campaigns/${campaignId}`, { fromNumberId: fx.numberA }, "PATCH");
    const started = await as(fx.cookieA, `/campaigns/${campaignId}/start`, {});
    expect(started.status).toBe(200);
    expect(((await started.json()) as { campaign: { status: string } }).campaign.status).toBe("running");

    expect((await as(fx.cookieA, `/campaigns/${campaignId}/start`, {})).status).toBe(409);
    expect((await as(fx.cookieA, `/campaigns/${campaignId}/pause`, {})).status).toBe(200);
  });

  test("shows its progress", async () => {
    const body = (await (await as(fx.cookieA, `/campaigns/${campaignId}`)).json()) as {
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({ pending: 2, suppressed: 1 });
  });

  test("another organisation can neither read nor control it", async () => {
    expect((await as(fx.cookieB, `/campaigns/${campaignId}`)).status).toBe(404);
    expect((await as(fx.cookieB, `/campaigns/${campaignId}/resume`, {})).status).toBe(404);
    expect((await as(fx.cookieB, `/campaigns/${campaignId}/contacts`, { csv: "phone\n9876543219" })).status).toBe(404);
    expect(await (await as(fx.cookieB, "/campaigns")).text()).not.toContain(campaignId);
  });
});

describe("the do-not-call list", () => {
  test("holds back contacts already waiting to be called", async () => {
    const created = await as(fx.cookieA, "/campaigns", { name: "Hold", agentId: fx.agentA });
    const { campaign } = (await created.json()) as { campaign: { id: string } };
    await as(fx.cookieA, `/campaigns/${campaign.id}/contacts`, { csv: "phone\n9876512345" });

    await as(fx.cookieA, "/suppressions", { numbers: ["+919876512345"] });
    const body = (await (await as(fx.cookieA, `/campaigns/${campaign.id}`)).json()) as {
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({ suppressed: 1 });
  });

  test("is per organisation", async () => {
    const text = await (await as(fx.cookieB, "/suppressions")).text();
    expect(text).not.toContain("+919876512345");
  });
});
