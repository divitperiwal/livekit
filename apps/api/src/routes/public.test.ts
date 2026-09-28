/**
 * The public API and the dashboard routes that set it up, over HTTP.
 *
 * Mostly isolation and secrecy: a key reaches only its own organisation, a
 * key without a scope cannot use it, and a key or signing secret is shown
 * exactly once.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import { agents, agentVersions, orgBalances, orgMembers, orgs, phoneNumbers, suppressedNumbers, users } from "../db/schema";
import { startCall } from "../services/calls";
import { placeCall } from "../services/outbound-call";
import type { Dispatcher } from "../services/dialer";
import { apiRoutes } from "./api";
import { publicRoutes } from "./public";

process.env.SECRETS_KEY ??= Buffer.alloc(32, 3).toString("base64");

const { sql, db } = createClient({ max: 3 });
const dashboard = apiRoutes(db);

class FakeDispatcher implements Dispatcher {
  dispatched: Array<Record<string, unknown>> = [];
  async dispatch(_room: string, metadata: Record<string, unknown>) {
    this.dispatched.push(metadata);
  }
}
const dispatcher = new FakeDispatcher();
const v1 = publicRoutes(db, () => dispatcher);

const PASSWORD = "test-password-1234";
const fx = {
  orgA: "", orgB: "", agentA: "", versionA: "", numberA: "",
  emailA: "", emailB: "", cookieA: "", cookieB: "", keyA: "", keyB: "", readOnlyKeyA: "",
};

async function login(email: string) {
  const response = await dashboard.request("http://api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function asUser(cookie: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return dashboard.request(`http://api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function withKey(key: string, path: string, body?: unknown) {
  return v1.request(`http://v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  for (const key of ["A", "B"] as const) {
    const lower = key.toLowerCase();
    const org = (await db.insert(orgs).values({ name: `Pub ${key}`, slug: `pub-${lower}-${suffix}` }).returning())[0]!;
    const email = `pub-${lower}-${suffix}@test.local`;
    const user = (await db.insert(users).values({ email, passwordHash: hash }).returning())[0]!;
    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
    await db.insert(orgBalances).values({ orgId: org.id, balanceInr: "500" });
    fx[`org${key}`] = org.id;
    fx[`email${key}`] = email;
  }
  const agent = (await db.insert(agents).values({ orgId: fx.orgA, name: "A", slug: `a-${suffix}` }).returning())[0]!;
  const version = (
    await db
      .insert(agentVersions)
      .values({ agentId: agent.id, orgId: fx.orgA, version: 1, instructions: "p", greeting: "g", config: {}, publishedAt: new Date() })
      .returning()
  )[0]!;
  await db.update(agents).set({ liveVersionId: version.id }).where(eq(agents.id, agent.id));
  const number = (
    await db
      .insert(phoneNumbers)
      .values({ orgId: fx.orgA, e164: `+9157${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, status: "assigned" })
      .returning()
  )[0]!;
  Object.assign(fx, { agentA: agent.id, versionA: version.id, numberA: number.id });

  fx.cookieA = await login(fx.emailA);
  fx.cookieB = await login(fx.emailB);
});

afterAll(async () => {
  for (const id of [fx.orgA, fx.orgB]) await db.delete(orgs).where(eq(orgs.id, id)).catch(() => {});
  for (const email of [fx.emailA, fx.emailB]) await db.delete(users).where(eq(users.email, email)).catch(() => {});
  await Promise.allSettled([sql.end(), closeRedis()]);
});

describe("API keys", () => {
  test("a key is returned once, and never listed", async () => {
    const created = await asUser(fx.cookieA, "/api-keys", { name: "CRM sync" });
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as { key: string };
    expect(key).toMatch(/^am_live_[0-9a-f]{12}_/);
    fx.keyA = key;

    const listed = await (await asUser(fx.cookieA, "/api-keys")).text();
    expect(listed).not.toContain(key);
    expect(listed).toContain("CRM sync");

    fx.keyB = ((await (await asUser(fx.cookieB, "/api-keys", { name: "B" })).json()) as { key: string }).key;
    fx.readOnlyKeyA = (
      (await (await asUser(fx.cookieA, "/api-keys", { name: "reporting", scopes: ["calls:read"] })).json()) as { key: string }
    ).key;
  });

  test("no key, a malformed key and a made-up key are all refused", async () => {
    expect((await v1.request("http://v1/calls")).status).toBe(401);
    expect((await withKey("not-a-key", "/calls")).status).toBe(401);
    expect((await withKey(fx.keyA.slice(0, -4) + "AAAA", "/calls")).status).toBe(401);
  });

  test("a key without the scope cannot use the route", async () => {
    expect((await withKey(fx.readOnlyKeyA, "/calls")).status).toBe(200);
    const response = await withKey(fx.readOnlyKeyA, "/calls", { agentId: fx.agentA, to: "+14155550100" });
    expect(response.status).toBe(403);
  });

  test("a revoked key stops working", async () => {
    const created = (await (await asUser(fx.cookieA, "/api-keys", { name: "temp" })).json()) as {
      key: string;
      apiKey: { id: string };
    };
    expect((await withKey(created.key, "/calls")).status).toBe(200);
    await asUser(fx.cookieA, `/api-keys/${created.apiKey.id}`, undefined, "DELETE");
    expect((await withKey(created.key, "/calls")).status).toBe(401);
  });
});

describe("placing a call", () => {
  test("dispatches the agent to dial, with a request id to find the call by", async () => {
    const response = await withKey(fx.keyA, "/calls", {
      agentId: fx.agentA,
      to: "+1 415 555 0100",
      variables: { name: "Asha", amount: 1200 },
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { requestId: string; to: string };
    expect(body.to).toBe("+14155550100");
    expect(dispatcher.dispatched.at(-1)).toMatchObject({
      orgId: fx.orgA,
      agentId: fx.agentA,
      placeCall: true,
      toNumber: "+14155550100",
      requestId: body.requestId,
      variables: { name: "Asha", amount: "1200" },
    });

    // The worker opens the record with the request id once the call connects.
    const call = await startCall(db, {
      orgId: fx.orgA,
      agentId: fx.agentA,
      agentVersionId: fx.versionA,
      lkRoomName: "r",
      lkJobId: `JOB_${crypto.randomUUID()}`,
      direction: "outbound",
      requestId: body.requestId,
    });
    const found = (await (await withKey(fx.keyA, `/calls?requestId=${body.requestId}`)).json()) as {
      calls: Array<{ id: string }>;
    };
    expect(found.calls.map((c) => c.id)).toEqual([call.id]);
  });

  test("another organisation's agent is not found", async () => {
    expect((await withKey(fx.keyB, "/calls", { agentId: fx.agentA, to: "+14155550100" })).status).toBe(404);
  });

  test("a number on the do-not-call list is refused", async () => {
    await db.insert(suppressedNumbers).values({ orgId: fx.orgA, e164: "+14155550199", source: "manual" });
    expect((await withKey(fx.keyA, "/calls", { agentId: fx.agentA, to: "+14155550199" })).status).toBe(409);
  });

  test("an Indian number is refused outside 09:00-21:00 India time", async () => {
    const night = new Date("2026-09-28T17:00:00Z"); // 22:30 IST
    await expect(
      placeCall(db, dispatcher, fx.orgA, { agentId: fx.agentA, to: "9876543210" }, night),
    ).rejects.toMatchObject({ status: 422 });
    const day = new Date("2026-09-28T06:00:00Z"); // 11:30 IST
    await expect(placeCall(db, dispatcher, fx.orgA, { agentId: fx.agentA, to: "9876543210" }, day)).resolves.toMatchObject({
      to: "+919876543210",
    });
  });

  test("not a phone number", async () => {
    expect((await withKey(fx.keyA, "/calls", { agentId: fx.agentA, to: "call me" })).status).toBe(422);
  });

  test("a malformed id is the request's mistake, not a server error", async () => {
    // Once a 500: the id reached Postgres, which refused it as a UUID.
    expect((await withKey(fx.keyA, "/calls", { agentId: "x", to: "+14155550100" })).status).toBe(422);
    expect(
      (await withKey(fx.keyA, "/calls", { agentId: fx.agentA, to: "+14155550100", fromNumberId: "nope" })).status,
    ).toBe(422);
  });

  test("without LiveKit configured, a valid request is a 503 and an invalid one still a 422", async () => {
    // Once a 500 for both: the dispatcher was built before anything was checked.
    const unconfigured = publicRoutes(db, () => {
      throw new Error("dispatching agents needs LIVEKIT_URL");
    });
    const ask = (body: unknown) =>
      unconfigured.request("http://v1/calls", {
        method: "POST",
        headers: { authorization: `Bearer ${fx.keyA}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await ask({ agentId: fx.agentA, to: "not a number" })).status).toBe(422);
    expect((await ask({ agentId: fx.agentA, to: "+14155550123" })).status).toBe(503);
  });
});

describe("reading calls", () => {
  test("a key reads only its own organisation's calls", async () => {
    const call = await startCall(db, {
      orgId: fx.orgA,
      agentId: fx.agentA,
      agentVersionId: fx.versionA,
      lkRoomName: "r",
      lkJobId: `JOB_${crypto.randomUUID()}`,
      direction: "inbound",
    });
    expect((await withKey(fx.keyA, `/calls/${call.id}`)).status).toBe(200);
    expect((await withKey(fx.keyB, `/calls/${call.id}`)).status).toBe(404);
    expect(await (await withKey(fx.keyB, "/calls")).text()).not.toContain(call.id);
  });
});

describe("webhook endpoints", () => {
  test("the signing secret is shown once", async () => {
    const created = await asUser(fx.cookieA, "/webhooks", { url: "https://hooks.example.com/x" });
    expect(created.status).toBe(201);
    const { secret } = (await created.json()) as { secret: string };
    expect(secret).toMatch(/^whsec_/);
    const listed = await (await asUser(fx.cookieA, "/webhooks")).text();
    expect(listed).not.toContain(secret);
    expect(listed).not.toContain("secretCiphertext");
  });

  test("an internal URL is refused", async () => {
    expect((await asUser(fx.cookieA, "/webhooks", { url: "https://localhost/hook" })).status).toBe(422);
    expect((await asUser(fx.cookieA, "/webhooks", { url: "http://hooks.example.com/" })).status).toBe(422);
  });

  test("another organisation cannot see or change them", async () => {
    const list = (await (await asUser(fx.cookieA, "/webhooks")).json()) as { endpoints: Array<{ id: string }> };
    const id = list.endpoints[0]!.id;
    expect(await (await asUser(fx.cookieB, "/webhooks")).text()).not.toContain(id);
    expect((await asUser(fx.cookieB, `/webhooks/${id}`, { enabled: false }, "PATCH")).status).toBe(404);
    expect((await asUser(fx.cookieB, `/webhooks/${id}/test`, {})).status).toBe(404);
  });
});

describe("knowledge and agents", () => {
  test("a knowledge base can be attached, is carried over, and cannot be borrowed", async () => {
    const created = (await (await asUser(fx.cookieA, "/knowledge-bases", { name: "FAQ" })).json()) as {
      knowledgeBase: { id: string };
    };
    const kb = created.knowledgeBase.id;
    expect(
      (await asUser(fx.cookieA, `/knowledge-bases/${kb}/documents`, { title: "Hours", text: "Open 9 to 7." })).status,
    ).toBe(201);

    await asUser(fx.cookieA, `/agents/${fx.agentA}/versions`, {
      instructions: "p", greeting: "g", config: {}, knowledgeBaseIds: [kb],
    });
    await asUser(fx.cookieA, `/agents/${fx.agentA}/versions`, { instructions: "p2", greeting: "g", config: {} });
    const detail = (await (await asUser(fx.cookieA, `/agents/${fx.agentA}`)).json()) as { knowledgeBaseIds: string[] };
    expect(detail.knowledgeBaseIds).toEqual([kb]);

    expect((await asUser(fx.cookieB, `/knowledge-bases/${kb}`)).status).toBe(404);
    expect((await asUser(fx.cookieB, `/knowledge-bases/${kb}/documents`, { text: "x" })).status).toBe(404);
  });
});

describe("settings", () => {
  test("recording can be turned on, with a bounded retention", async () => {
    expect((await asUser(fx.cookieA, "/settings", { recordCalls: true, recordingRetentionDays: 90 }, "PATCH")).status).toBe(200);
    const settings = (await (await asUser(fx.cookieA, "/settings")).json()) as { recordCalls: boolean; recordingRetentionDays: number };
    expect(settings).toMatchObject({ recordCalls: true, recordingRetentionDays: 90 });
    expect((await asUser(fx.cookieA, "/settings", { recordingRetentionDays: 0 }, "PATCH")).status).toBe(422);
  });
});
