/**
 * Analytics, experiments, test runs, the team, redaction and erasure.
 *
 * The properties that matter most: an experiment splits calls but never
 * serves another tenant; a removed member loses access at once; an invite
 * cannot take over an existing account; erasure removes the person but keeps
 * the money; and redaction happens before anything is stored.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import {
  agents,
  agentVersions,
  callEvents,
  calls,
  campaignContacts,
  campaigns,
  orgBalances,
  orgMembers,
  orgs,
  usageRecords,
  users,
} from "../db/schema";
import { pickVersion, type AgentRouting } from "../services/agent-resolution";
import { appendEvents, finalizeCall, startCall } from "../services/calls";
import { redact } from "../services/redact";
import { apiRoutes } from "./api";
import { internalRoutes } from "./internal";

const { sql, db } = createClient({ max: 3 });
// Always the unconfigured dispatcher, whatever .env holds: a test must never
// start a real job on someone's LiveKit project.
const app = apiRoutes(db, () => {
  throw new Error("dispatching agents needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET");
});
const internal = internalRoutes(db);

const PASSWORD = "test-password-1234";
const fx = { org: "", other: "", agent: "", v1: "", v2: "", otherAgent: "", email: "", cookie: "", otherCookie: "", otherEmail: "" };

async function login(email: string, password = PASSWORD) {
  const response = await app.request("http://api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
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
  for (const which of ["org", "other"] as const) {
    const org = (await db.insert(orgs).values({ name: which, slug: `ins-${which}-${suffix}` }).returning())[0]!;
    const email = `ins-${which}-${suffix}@test.local`;
    const user = (await db.insert(users).values({ email, passwordHash: hash }).returning())[0]!;
    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
    await db.insert(orgBalances).values({ orgId: org.id, balanceInr: "500" });
    fx[which] = org.id;
    if (which === "org") fx.email = email;
    else fx.otherEmail = email;
  }
  const agent = (await db.insert(agents).values({ orgId: fx.org, name: "A", slug: `a-${suffix}` }).returning())[0]!;
  const [v1, v2] = await db
    .insert(agentVersions)
    .values([1, 2].map((n) => ({ agentId: agent.id, orgId: fx.org, version: n, instructions: `p${n}`, greeting: "g", config: {} })))
    .returning();
  await db.update(agents).set({ liveVersionId: v1!.id }).where(eq(agents.id, agent.id));
  const otherAgent = (await db.insert(agents).values({ orgId: fx.other, name: "O", slug: `o-${suffix}` }).returning())[0]!;
  Object.assign(fx, { agent: agent.id, v1: v1!.id, v2: v2!.id, otherAgent: otherAgent.id });
  fx.cookie = await login(fx.email);
  fx.otherCookie = await login(fx.otherEmail);
});

afterAll(async () => {
  for (const id of [fx.org, fx.other]) await db.delete(orgs).where(eq(orgs.id, id)).catch(() => {});
  await db.delete(users).where(eq(users.email, fx.email)).catch(() => {});
  await db.delete(users).where(eq(users.email, fx.otherEmail)).catch(() => {});
  await Promise.allSettled([sql.end(), closeRedis()]);
});

describe("redaction", () => {
  test("masks what it should", () => {
    expect(redact("Call me on 98765 43210 or +91-98765-43210")).toBe("Call me on [phone] or [phone]");
    expect(redact("mail asha@example.com")).toBe("mail [email]");
    expect(redact("card 4111 1111 1111 1111")).toBe("card [card]");
    expect(redact("aadhaar 2345 6789 0123, pan ABCDE1234F")).toBe("aadhaar [aadhaar], pan [pan]");
    // Twelve digits that are 91 and a mobile number are a phone, not Aadhaar.
    expect(redact("919876543210")).toBe("[phone]");
  });

  test("leaves amounts, times and order numbers alone", () => {
    expect(redact("Rs 15,000 at 5:30, order 48213")).toBe("Rs 15,000 at 5:30, order 48213");
    // Sixteen digits that fail Luhn are not a card.
    expect(redact("ref 1234 5678 1234 5678")).not.toContain("[card]");
  });

  test("is applied before storage, for an organisation that opted in", async () => {
    await as(fx.cookie, "/settings", { redactPii: true }, "PATCH");
    const call = await startCall(db, {
      orgId: fx.org, agentId: fx.agent, agentVersionId: fx.v1, lkRoomName: "r", lkJobId: `JOB_${crypto.randomUUID()}`, direction: "inbound",
    });
    await appendEvents(db, call.id, fx.org, [
      { seq: 1, type: "user_message", role: "user", content: "my number is 9876543210", at: new Date().toISOString() },
      { seq: 2, type: "tool_call", role: "assistant", content: "crm", payload: { arguments: '{"phone":"9876543210"}' }, at: new Date().toISOString() },
    ]);
    await finalizeCall(db, call.id, { status: "completed", analysis: { summary: "Caller gave 9876543210.", fields: { callback: "9876543210" } } });

    const stored = await db.select().from(callEvents).where(eq(callEvents.callId, call.id));
    expect(JSON.stringify(stored.map((e) => [e.content, e.payload]))).not.toContain("9876543210");
    const row = (await db.select().from(calls).where(eq(calls.id, call.id)))[0]!;
    expect(row.summary).toBe("Caller gave [phone].");
    // Structured fields are what the business asked to capture, and are kept.
    expect(row.analysis).toEqual({ callback: "9876543210" });
    await as(fx.cookie, "/settings", { redactPii: false }, "PATCH");
  });
});

describe("experiments", () => {
  const routing: AgentRouting = { agentId: "a", orgId: "o", liveVersionId: "live", candidateVersionId: "cand", candidatePercent: 20 };

  test("the candidate gets its share and no more", () => {
    expect(pickVersion(routing, 0.1)).toBe("cand");
    expect(pickVersion(routing, 0.2)).toBe("live");
    expect(pickVersion({ ...routing, candidatePercent: 0 }, 0)).toBe("live");
    const picks = Array.from({ length: 1000 }, (_, i) => pickVersion(routing, i / 1000));
    expect(picks.filter((p) => p === "cand")).toHaveLength(200);
  });

  test("an experiment must use another version of the same agent", async () => {
    expect((await as(fx.cookie, `/agents/${fx.agent}/experiment`, { versionId: fx.v1, percent: 50 }, "PUT")).status).toBe(409);
    expect((await as(fx.cookie, `/agents/${fx.agent}/experiment`, { versionId: fx.v2, percent: 100 }, "PUT")).status).toBe(422);
    expect((await as(fx.otherCookie, `/agents/${fx.agent}/experiment`, { versionId: fx.v2, percent: 50 }, "PUT")).status).toBe(404);
  });

  test("calls are split between the versions, and never leave the tenant", async () => {
    expect((await as(fx.cookie, `/agents/${fx.agent}/experiment`, { versionId: fx.v2, percent: 50 }, "PUT")).status).toBe(200);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const response = await internal.request(`http://internal/resolve?agentId=${fx.agent}&orgId=${fx.org}`);
      seen.add(((await response.json()) as { agentVersionId: string }).agentVersionId);
    }
    expect(seen).toEqual(new Set([fx.v1, fx.v2]));
    const forged = await internal.request(`http://internal/resolve?agentId=${fx.agent}&orgId=${fx.other}`);
    expect(forged.status).toBe(403);

    await as(fx.cookie, `/agents/${fx.agent}/experiment`, { versionId: null }, "PUT");
    const after = await internal.request(`http://internal/resolve?agentId=${fx.agent}`);
    expect(((await after.json()) as { agentVersionId: string }).agentVersionId).toBe(fx.v1);
  });
});

describe("analytics", () => {
  test("counts, rates, dispositions and versions describe the same calls", async () => {
    for (const [status, disposition, answered] of [
      ["completed", "interested", true],
      ["completed", "not_interested", true],
      ["no_answer", null, false],
    ] as const) {
      const call = await startCall(db, {
        orgId: fx.org, agentId: fx.agent, agentVersionId: fx.v2, lkRoomName: "r", lkJobId: `JOB_${crypto.randomUUID()}`,
        direction: "outbound", answered,
      });
      await finalizeCall(db, call.id, {
        status,
        durationSeconds: answered ? 60 : 0,
        analysis: disposition ? { disposition, qa: [{ criterion: "c", passed: disposition === "interested" }] } : undefined,
        latency: answered ? { p50: 1.2, p95: 2.0 } : undefined,
      });
    }
    const body = (await (await as(fx.cookie, `/analytics?agentId=${fx.agent}`)).json()) as {
      totals: { outbound: number; outboundAnswered: number; answerRate: number; latencyP50: number };
      dispositions: Array<{ disposition: string; calls: number }>;
      versions: Array<{ agentVersionId: string; calls: number; qaPassRate: number }>;
    };
    expect(body.totals.outbound).toBe(3);
    expect(body.totals.answerRate).toBeCloseTo(2 / 3);
    expect(body.totals.latencyP50).toBeCloseTo(1.2);
    expect(body.dispositions.map((d) => d.disposition).sort()).toEqual(["interested", "not_interested"]);
    const v2 = body.versions.find((v) => v.agentVersionId === fx.v2)!;
    expect(v2.calls).toBe(3);
    expect(v2.qaPassRate).toBeCloseTo(0.5);

    const other = (await (await as(fx.otherCookie, "/analytics")).json()) as { totals: { calls: number } };
    expect(other.totals.calls).toBe(0);
  });
});

describe("creating agents", () => {
  test("a new agent is published and callable at once, with a unique slug", async () => {
    const a = (await (await as(fx.cookie, "/agents", { name: "Service Desk" })).json()) as { agent: { id: string; slug: string } };
    const b = (await (await as(fx.cookie, "/agents", { name: "Service Desk" })).json()) as { agent: { id: string; slug: string } };
    expect(a.agent.slug).toBe("service-desk");
    expect(b.agent.slug).toBe("service-desk-2");
    const resolved = await internal.request(`http://internal/resolve?agentId=${a.agent.id}`);
    expect(resolved.status).toBe(200);
  });
});

describe("test runs", () => {
  test("scenarios are the agent's own, and a run without LiveKit fails loudly", async () => {
    expect(
      (await as(fx.otherCookie, `/agents/${fx.agent}/scenarios`, { name: "x", caller: "y", criteria: ["z"] })).status,
    ).toBe(404);
    expect((await as(fx.cookie, `/agents/${fx.agent}/scenarios`, { name: "x", caller: "y", criteria: [] })).status).toBe(422);
    const created = await as(fx.cookie, `/agents/${fx.agent}/scenarios`, {
      name: "Price question", caller: "A buyer asking the Thar's price", criteria: ["Gave the price"],
    });
    expect(created.status).toBe(201);

    const run = await as(fx.cookie, `/agents/${fx.agent}/eval-runs`, {});
    // No LiveKit in the test environment: refused with the local alternative.
    expect(run.status).toBe(503);
    expect(((await run.json()) as { error: string }).error).toContain("uv run evals");
  });

  test("the worker's side: fetch, report, finish", async () => {
    const scenario = (
      (await (await as(fx.cookie, `/agents/${fx.agent}/scenarios`)).json()) as { scenarios: Array<{ id: string }> }
    ).scenarios[0]!;
    const { evalRuns } = await import("../db/schema");
    const run = (await db.insert(evalRuns).values({ orgId: fx.org, agentId: fx.agent, agentVersionId: fx.v1 }).returning())[0]!;

    const fetched = (await (await internal.request(`http://internal/eval-runs/${run.id}`)).json()) as {
      scenarios: unknown[];
      agent: { instructions: string; tools: unknown[] };
    };
    expect(fetched.scenarios).toHaveLength(1);
    expect(fetched.agent.instructions).toBe("p1");

    const post = (path: string, body: unknown) =>
      internal.request(`http://internal/eval-runs/${run.id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const result = { scenarioId: scenario.id, passed: true, transcript: [{ role: "caller", text: "hi" }], judgments: [], turns: 1 };
    await post("results", result);
    await post("results", { ...result, passed: false }); // a retry replaces, not duplicates
    await post("finish", { status: "completed", passed: 0, total: 1, tokens: 900 });

    const view = (await (await as(fx.cookie, `/eval-runs/${run.id}`)).json()) as {
      run: { status: string; tokens: number };
      results: Array<{ passed: boolean }>;
    };
    expect(view.run).toMatchObject({ status: "completed", tokens: 900 });
    expect(view.results.map((r) => r.passed)).toEqual([false]);
    expect((await as(fx.otherCookie, `/eval-runs/${run.id}`)).status).toBe(404);
  });
});

describe("the team", () => {
  test("an invited person joins with the role they were invited with", async () => {
    const invited = (await (await as(fx.cookie, "/team/invites", { email: `new-${fx.org.slice(0, 6)}@test.local`, role: "viewer" })).json()) as {
      token: string;
    };
    const accepted = await app.request("http://api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invited.token, password: "a-long-password-1", name: "New Person" }),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { role: string }).role).toBe("viewer");

    // Used once, never again.
    const again = await app.request("http://api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invited.token, password: "a-long-password-1" }),
    });
    expect(again.status).toBe(410);
  });

  test("an invite cannot take over an existing account", async () => {
    const invited = (await (await as(fx.cookie, "/team/invites", { email: fx.otherEmail, role: "admin" })).json()) as { token: string };
    const hijack = await app.request("http://api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invited.token, password: "not-their-password" }),
    });
    expect(hijack.status).toBe(401);
  });

  test("a removed member loses access immediately, and the last owner stays", async () => {
    const team = (await (await as(fx.cookie, "/team")).json()) as { members: Array<{ userId: string; email: string; role: string }> };
    const viewer = team.members.find((m) => m.role === "viewer")!;
    const viewerCookie = await login(viewer.email, "a-long-password-1");
    expect((await as(viewerCookie, "/calls")).status).toBe(200);

    expect((await as(fx.cookie, `/team/members/${viewer.userId}`, undefined, "DELETE")).status).toBe(200);
    expect((await as(viewerCookie, "/calls")).status).toBe(401);

    const owner = team.members.find((m) => m.role === "owner")!;
    expect((await as(fx.cookie, `/team/members/${owner.userId}`, { role: "admin" }, "PATCH")).status).toBe(409);
  });
});

describe("erasure", () => {
  test("removes the person, keeps the money, and stops pending calls to them", async () => {
    const phone = "+919812345678";
    const call = await startCall(db, {
      orgId: fx.org, agentId: fx.agent, agentVersionId: fx.v1, lkRoomName: "r", lkJobId: `JOB_${crypto.randomUUID()}`,
      direction: "outbound", toNumber: phone, variables: { name: "Asha" },
    });
    await appendEvents(db, call.id, fx.org, [{ seq: 1, type: "user_message", role: "user", content: "hi", at: new Date().toISOString() }]);
    await finalizeCall(db, call.id, {
      status: "completed", durationSeconds: 60, analysis: { summary: "Asha called" },
      usage: { sttSeconds: 60, ttsCharacters: 100, llmPromptTokens: 100, llmCachedTokens: 0, llmCompletionTokens: 10 },
    });
    const campaign = (await db.insert(campaigns).values({ orgId: fx.org, agentId: fx.agent, name: "c" }).returning())[0]!;
    await db.insert(campaignContacts).values({ campaignId: campaign.id, orgId: fx.org, e164: phone, variables: { name: "Asha" } });

    expect((await as(fx.otherCookie, "/privacy/erase", { phone })).status).toBe(200); // another org: finds nothing
    const response = await as(fx.cookie, "/privacy/erase", { phone: "98123 45678" });
    const report = (await response.json()) as { calls: number; campaignContacts: number };
    expect(report).toMatchObject({ calls: 1, campaignContacts: 1 });

    const row = (await db.select().from(calls).where(eq(calls.id, call.id)))[0]!;
    expect([row.toNumber, row.summary, row.metadata]).toEqual([null, null, { erased: true }]);
    expect(await db.select().from(callEvents).where(eq(callEvents.callId, call.id))).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.callId, call.id))).toHaveLength(1);
    const contact = (await db.select().from(campaignContacts).where(eq(campaignContacts.campaignId, campaign.id)))[0]!;
    expect(contact.e164.startsWith("erased:")).toBe(true);
    expect(contact.status).toBe("suppressed");
    expect(contact.variables).toEqual({});
  });
});
