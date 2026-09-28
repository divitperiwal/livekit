/**
 * Webhooks, recording retention and the analysis on a finished call, against
 * a real database.
 *
 * The webhook properties that matter: an event is queued in the same
 * transaction as the call it reports, the same event is never queued twice,
 * a request is signed so the receiver can check it, a failing endpoint is
 * retried and then given up on, and two senders never send one delivery.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import { agents, agentVersions, calls, orgs, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { finalizeCall, startCall } from "./calls";
import { sweepExpiredRecordings } from "./recordings";
import { encryptSecret } from "./secrets";
import { deliverDue, RETRY_SCHEDULE_MS, signPayload, type Sender } from "./webhooks";

process.env.SECRETS_KEY ??= Buffer.alloc(32, 5).toString("base64");

const { sql, db } = createClient({ max: 4 });
const SECRET = "whsec_test";
const fx = { org: "", agent: "", version: "", endpoint: "" };

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const org = (await db.insert(orgs).values({ name: "Hooks", slug: `hooks-${suffix}` }).returning())[0]!;
  const agent = (await db.insert(agents).values({ orgId: org.id, name: "A", slug: `a-${suffix}` }).returning())[0]!;
  const version = (
    await db
      .insert(agentVersions)
      .values({ agentId: agent.id, orgId: org.id, version: 1, instructions: "p", greeting: "g", config: {} })
      .returning()
  )[0]!;
  const endpoint = (
    await db
      .insert(webhookEndpoints)
      .values({
        orgId: org.id,
        url: "https://hooks.example.com/automitra",
        secretCiphertext: await encryptSecret(SECRET),
        events: ["call.ended"],
      })
      .returning()
  )[0]!;
  // Subscribed to something else: must receive nothing about calls.
  await db.insert(webhookEndpoints).values({
    orgId: org.id,
    url: "https://other.example.com/",
    secretCiphertext: await encryptSecret("x"),
    events: ["campaign.completed"],
  });
  Object.assign(fx, { org: org.id, agent: agent.id, version: version.id, endpoint: endpoint.id });
});

afterAll(async () => {
  await db.delete(orgs).where(eq(orgs.id, fx.org)).catch(() => {});
  await Promise.allSettled([sql.end(), closeRedis()]);
});

async function finishedCall(analysis?: Parameters<typeof finalizeCall>[2]["analysis"]) {
  const call = await startCall(db, {
    orgId: fx.org,
    agentId: fx.agent,
    agentVersionId: fx.version,
    lkRoomName: "room",
    lkJobId: `JOB_${crypto.randomUUID()}`,
    direction: "outbound",
    toNumber: "+14155550100",
    requestId: "req-123",
    variables: { name: "Asha" },
  });
  await finalizeCall(db, call.id, { status: "completed", durationSeconds: 42, analysis });
  return call;
}

async function deliveriesFor(callId: string) {
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventKey, `call.ended:${callId}`));
}

class RecordingSender {
  sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  constructor(private respond: () => number | Error = () => 200) {}
  send: Sender = async (url, request) => {
    this.sent.push({ url, headers: request.headers ?? {}, body: request.body ?? "" });
    const outcome = this.respond();
    if (outcome instanceof Error) throw outcome;
    return { status: outcome, headers: {}, body: "ok" };
  };
}

describe("queueing", () => {
  test("a finished call queues call.ended for subscribed endpoints only", async () => {
    const call = await finishedCall();
    const queued = await deliveriesFor(call.id);
    expect(queued.map((d) => d.endpointId)).toEqual([fx.endpoint]);
  });

  test("finalising twice queues once", async () => {
    const call = await finishedCall();
    await finalizeCall(db, call.id, { status: "completed", durationSeconds: 43 });
    expect(await deliveriesFor(call.id)).toHaveLength(1);
  });

  test("the event carries the call, its analysis and its transcript", async () => {
    const call = await finishedCall({
      summary: "Wants a test drive.",
      disposition: "interested",
      fields: { callback_time: "tomorrow 5pm" },
    });
    const payload = (await deliveriesFor(call.id))[0]!.payload as {
      event: string;
      data: Record<string, unknown>;
    };
    expect(payload.event).toBe("call.ended");
    expect(payload.data).toMatchObject({
      id: call.id,
      status: "completed",
      summary: "Wants a test drive.",
      disposition: "interested",
      fields: { callback_time: "tomorrow 5pm" },
      variables: { name: "Asha" },
      requestId: "req-123",
      transcript: [],
    });
  });

  test("the analysis is stored on the call", async () => {
    const call = await finishedCall({ summary: "S", disposition: "interested", fields: { budget: 5 } });
    const row = (await db.select().from(calls).where(eq(calls.id, call.id)))[0]!;
    expect([row.summary, row.disposition, row.analysis]).toEqual(["S", "interested", { budget: 5 }]);
  });
});

describe("delivering", () => {
  test("a delivery is signed, and marked delivered on a 2xx", async () => {
    const call = await finishedCall();
    const sender = new RecordingSender();
    await deliverDue(db, new Date(), sender.send, 1000);

    const sent = sender.sent.find((s) => s.body.includes(call.id))!;
    expect(sent.url).toBe("https://hooks.example.com/automitra");
    const { "x-automitra-timestamp": ts, "x-automitra-signature": signature } = sent.headers;
    expect(signature).toBe(signPayload(SECRET, ts!, sent.body));
    expect(sent.headers["x-automitra-event-id"]).toBe(`call.ended:${call.id}`);
    expect((await deliveriesFor(call.id))[0]!.status).toBe("delivered");
  });

  test("a failing endpoint is retried on the schedule, then given up on", async () => {
    const call = await finishedCall();
    const sender = new RecordingSender(() => 500);
    let now = new Date();

    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      await deliverDue(db, now, sender.send, 1000);
      const [delivery] = await deliveriesFor(call.id);
      expect(delivery!.status).toBe("pending");
      expect(delivery!.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_SCHEDULE_MS[attempt - 1]!);
      now = new Date(delivery!.nextAttemptAt.getTime() + 1);
    }

    await deliverDue(db, now, sender.send, 1000);
    const [final] = await deliveriesFor(call.id);
    expect(final!.status).toBe("failed");
    expect(final!.attempts).toBe(RETRY_SCHEDULE_MS.length + 1);
    expect(final!.lastStatusCode).toBe(500);
  });

  test("a network error is retried like an error status", async () => {
    const call = await finishedCall();
    await deliverDue(db, new Date(), new RecordingSender(() => new Error("ECONNREFUSED")).send, 1000);
    const [delivery] = await deliveriesFor(call.id);
    expect(delivery!.status).toBe("pending");
    expect(delivery!.lastError).toContain("ECONNREFUSED");
  });

  test("two senders at once never send the same delivery", async () => {
    const call = await finishedCall();
    const a = new RecordingSender();
    const b = new RecordingSender();
    const now = new Date();
    await Promise.all([deliverDue(db, now, a.send, 1000), deliverDue(db, now, b.send, 1000)]);
    const copies = [...a.sent, ...b.sent].filter((s) => s.body.includes(call.id));
    expect(copies).toHaveLength(1);
  });

  test("a disabled endpoint's pending deliveries are given up on", async () => {
    const call = await finishedCall();
    await db.update(webhookEndpoints).set({ enabled: false }).where(eq(webhookEndpoints.id, fx.endpoint));
    try {
      const sender = new RecordingSender();
      await deliverDue(db, new Date(), sender.send, 1000);
      expect(sender.sent.filter((s) => s.body.includes(call.id))).toHaveLength(0);
      expect((await deliveriesFor(call.id))[0]!.status).toBe("failed");
    } finally {
      await db.update(webhookEndpoints).set({ enabled: true }).where(eq(webhookEndpoints.id, fx.endpoint));
    }
  });
});

describe("recording retention", () => {
  test("deletes the object, then forgets the key; keeps what is still in retention", async () => {
    const old = await finishedCall();
    const recent = await finishedCall();
    await db
      .update(calls)
      .set({ recordingKey: "recordings/old.ogg", endedAt: new Date(Date.now() - 40 * 86400_000) })
      .where(eq(calls.id, old.id));
    await db.update(calls).set({ recordingKey: "recordings/recent.ogg" }).where(eq(calls.id, recent.id));

    const deleted: string[] = [];
    const store = { delete: async (key: string) => void deleted.push(key) };
    await sweepExpiredRecordings(db, new Date(), store as never);

    expect(deleted).toContain("recordings/old.ogg");
    expect(deleted).not.toContain("recordings/recent.ogg");
    const rows = await db.select({ id: calls.id, key: calls.recordingKey }).from(calls).where(eq(calls.orgId, fx.org));
    expect(rows.find((r) => r.id === old.id)?.key).toBeNull();
    expect(rows.find((r) => r.id === recent.id)?.key).toBe("recordings/recent.ogg");
  });

  test("a failed delete keeps the key, so the next sweep tries again", async () => {
    const call = await finishedCall();
    await db
      .update(calls)
      .set({ recordingKey: "recordings/stuck.ogg", endedAt: new Date(Date.now() - 40 * 86400_000) })
      .where(eq(calls.id, call.id));
    const store = {
      delete: async () => {
        throw new Error("403");
      },
    };
    await sweepExpiredRecordings(db, new Date(), store as never);
    const row = (await db.select().from(calls).where(eq(calls.id, call.id)))[0]!;
    expect(row.recordingKey).toBe("recordings/stuck.ogg");
  });
});
