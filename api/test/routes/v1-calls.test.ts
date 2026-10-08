import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accountLedger, accounts, calls } from "../../src/db/schema";
import { assertWorkerAccepts } from "../contracts/worker-contract";
import { oneMinuteOfUsage } from "../fixtures/rate-card";
import { event } from "../http/scenario";
import { TEST_INTERNAL_SECRET } from "../http/test-app";
import { createV1Scenario, ORG_NUMBER } from "../http/v1-scenario";

const CUSTOMER = "+919876543210";

async function internalPost(
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  path: string,
  body: unknown,
) {
  assertWorkerAccepts(
    path.endsWith("/finalize")
      ? "FinalizeCallRequest"
      : path.endsWith("/events")
        ? "AppendEventsRequest"
        : "OpenCallRequest",
    body,
  );
  const response = await app.request(`/internal${path}`, {
    method: "POST",
    headers: { "x-internal-secret": TEST_INTERNAL_SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe("POST /v1/orgs/:externalId/calls", () => {
  test("queues the call, returns its id and dispatches the worker to dial from the org's number", async () => {
    const { api, db, dispatches, withOrgAndAgent } = await createV1Scenario();
    const { org, agentId } = await withOrgAndAgent();
    const placed = await api("POST", "/orgs/clinic-42/calls", {
      agentId,
      to: CUSTOMER,
      variables: { name: "Ravi" },
    });
    expect(placed.status).toBe(202);
    expect(placed.body).toMatchObject({
      orgId: "clinic-42",
      status: "queued",
      to: CUSTOMER,
      from: ORG_NUMBER,
      finalized: false,
      usage: null,
    });

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.roomName).toMatch(/^call-[0-9a-f]{12}$/);
    expect(dispatches[0]!.metadata).toMatchObject({
      placeCall: true,
      direction: "outbound",
      orgId: org.id,
      agentId,
      toNumber: CUSTOMER,
      fromNumber: ORG_NUMBER,
      variables: { name: "Ravi" },
      requestId: placed.body.id,
    });
  });

  test("the worker's open keeps the client's call id; polling it shows the finished call", async () => {
    const { api, app, dispatches, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const placed = (await api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).body;
    const metadata = dispatches[0]!.metadata as Record<string, any>;

    const opened = await internalPost(app, "/calls", {
      orgId: metadata.orgId,
      agentId: metadata.agentId,
      agentVersionId: metadata.agentVersionId,
      lkRoomName: dispatches[0]!.roomName,
      lkJobId: "AJ_outbound_1",
      direction: "outbound",
      fromNumber: metadata.fromNumber,
      toNumber: metadata.toNumber,
      phoneNumberId: metadata.phoneNumberId,
      answered: true,
      variables: {},
      campaignId: null,
      contactId: null,
      requestId: metadata.requestId,
    });
    expect(opened.body.id).toBe(placed.id);

    await internalPost(app, `/calls/${placed.id}/events`, {
      orgId: metadata.orgId,
      events: [event(1, { content: "Haan, boliye" })],
    });
    expect((await api("GET", `/orgs/clinic-42/calls/${placed.id}`)).body).toMatchObject({
      status: "in_progress",
      finalized: false,
    });

    await internalPost(app, `/calls/${placed.id}/finalize`, {
      status: "completed",
      endReason: "agent_ended",
      durationSeconds: 60,
      doNotCall: false,
      recordingKey: null,
      latency: null,
      analysis: null,
      usage: oneMinuteOfUsage,
    });
    const polled = (await api("GET", `/orgs/clinic-42/calls/${placed.id}`)).body;
    expect(polled).toMatchObject({
      id: placed.id,
      status: "completed",
      finalized: true,
      durationSeconds: 60,
      usage: { priceInr: 6 },
    });
    expect(polled.transcript).toEqual([
      { seq: 1, role: "user", content: "Haan, boliye", at: "2026-10-05T10:00:01.000Z" },
    ]);
  });

  test("refuses without a usable caller ID", async () => {
    const { api, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    expect(
      (await api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER, from: "+918000000000" }))
        .status,
    ).toBe(422);
    await api("PUT", "/orgs/other", { name: "Other" });
    const otherAgent = (
      await api("POST", "/orgs/other/agents", {
        name: "A",
        slug: "a",
        instructions: "x",
        greeting: "y",
      })
    ).body;
    await api("POST", `/orgs/other/agents/${otherAgent.id}/publish`, {});
    expect(
      (await api("POST", "/orgs/other/calls", { agentId: otherAgent.id, to: CUSTOMER })).body.error,
    ).toBe("the org has no outbound number");
  });

  test("refuses an unpublished or unknown agent and a bad number", async () => {
    const { api, withOrgAndAgent } = await createV1Scenario();
    await withOrgAndAgent();
    const draftOnly = (
      await api("POST", "/orgs/clinic-42/agents", {
        name: "B",
        slug: "b",
        instructions: "x",
        greeting: "y",
      })
    ).body;
    expect(
      (await api("POST", "/orgs/clinic-42/calls", { agentId: draftOnly.id, to: CUSTOMER })).status,
    ).toBe(422);
    expect(
      (await api("POST", "/orgs/clinic-42/calls", { agentId: crypto.randomUUID(), to: CUSTOMER }))
        .status,
    ).toBe(404);
    expect(
      (await api("POST", "/orgs/clinic-42/calls", { agentId: draftOnly.id, to: "98765" })).status,
    ).toBe(400);
  });

  test("429 past the key's concurrency, and a finished call frees the slot", async () => {
    const { v1, issue, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const key = await issue({ maxConcurrentCalls: 1 });
    const first = await v1(key, "POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER });
    const second = await v1(key, "POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER });
    expect(second.status).toBe(429);
    await db
      .update(calls)
      .set({ status: "completed", lkJobId: "AJ_done" })
      .where(eq(calls.id, first.body.id));
    expect((await v1(key, "POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).status).toBe(
      202,
    );
  });

  test("a failed dispatch fails the call, frees the slot and says nothing was dialled", async () => {
    const { v1, issue, db, withOrgAndAgent } = await createV1Scenario({
      dispatcher: async () => {
        throw new Error("livekit unreachable");
      },
    });
    const { agentId } = await withOrgAndAgent();
    const key = await issue({ maxConcurrentCalls: 1 });
    const refused = await v1(key, "POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER });
    expect(refused).toMatchObject({
      status: 503,
      body: { error: "could not reach the call service; nothing was dialled" },
    });
    const [call] = await db.select().from(calls);
    expect(call).toMatchObject({ status: "failed", endReason: "dispatch_failed" });
    expect((await v1(key, "POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).status).toBe(
      503,
    );
    expect(await db.$count(calls, eq(calls.status, "queued"))).toBe(0);
  });

  test("503 when outbound calling is not configured", async () => {
    const { api, withOrgAndAgent } = await createV1Scenario({ dispatcher: null });
    const { agentId } = await withOrgAndAgent();
    expect((await api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).status).toBe(
      503,
    );
  });
});

describe("the credit check on placing a call", () => {
  test("an account at its cap gets 402; a suspended account's key gets 403", async () => {
    const { api, db, account, withOrgAndAgent } = await createV1Scenario({
      account: { creditCapInr: "10.00" },
    });
    const { agentId } = await withOrgAndAgent();
    await db.insert(accountLedger).values({
      accountId: account.id,
      kind: "adjustment",
      amountInr: "-10.00",
      idempotencyKey: "debit",
    });
    expect((await api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).status).toBe(
      402,
    );
    await db.update(accounts).set({ status: "suspended" }).where(eq(accounts.id, account.id));
    expect((await api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).status).toBe(
      403,
    );
  });
});

describe("GET /v1/orgs/:externalId/calls", () => {
  test("lists newest first, a page at a time", async () => {
    const { api, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER })).body.id);
    const first = (await api("GET", "/orgs/clinic-42/calls?limit=2")).body;
    expect(first.calls).toHaveLength(2);
    const second = (await api("GET", `/orgs/clinic-42/calls?limit=2&before=${first.nextCursor}`))
      .body;
    expect(second.nextCursor).toBeNull();
    expect([...first.calls, ...second.calls].map((call: { id: string }) => call.id).sort()).toEqual(
      ids.sort(),
    );
    expect((await api("GET", "/orgs/clinic-42/calls?before=garbage")).status).toBe(400);
  });
});
