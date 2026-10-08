import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { webhookDeliveries, webhookEndpoints } from "../../src/db/schema";
import {
  deliverDueWebhooks,
  oldestUndeliveredUsageMs,
  pruneWebhookDeliveries,
  RETRY_DELAYS_MS,
  type WebhookPost,
} from "../../src/modules/webhooks/deliver";
import { seedAccount } from "../db/seed";
import { createTestDatabase } from "../db/test-database";
import { testSecretBox } from "../fixtures/secrets";

const SECRET = "whsec_test";
const T0 = new Date("2026-10-05T06:30:00Z");

async function queueWith(events: ("call.ended" | "usage.recorded")[]) {
  const { db } = await createTestDatabase();
  const account = await seedAccount(db);
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      accountId: account.id,
      url: "https://automitra.example/hooks",
      secretCiphertext: testSecretBox.encrypt(SECRET),
      events: ["call.ended", "usage.recorded"],
    })
    .returning();
  for (const [i, event] of events.entries()) {
    await db.insert(webhookDeliveries).values({
      endpointId: endpoint!.id,
      event,
      eventKey: `key-${i}`,
      payload: { n: i },
      nextAttemptAt: T0,
      createdAt: T0,
    });
  }
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  let answer: () => Promise<{ status: number }> = async () => ({ status: 200 });
  const post: WebhookPost = async (url, body, headers) => {
    sent.push({ url, body, headers });
    return answer();
  };
  let clock = T0;
  const deliver = () =>
    deliverDueWebhooks({ db, secretBox: testSecretBox, post, now: () => clock });
  const rows = () => db.select().from(webhookDeliveries).orderBy(webhookDeliveries.eventKey);
  return {
    db,
    endpoint: endpoint!,
    sent,
    deliver,
    rows,
    answerWith: (next: typeof answer) => (answer = next),
    setClock: (at: Date) => (clock = at),
  };
}

describe("webhook delivery", () => {
  test("a signed event is delivered once, with an id receivers can dedupe on", async () => {
    const { deliver, sent, rows } = await queueWith(["usage.recorded"]);
    expect(await deliver()).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    expect(await deliver()).toEqual({ delivered: 0, retrying: 0, failed: 0 });

    const [request] = sent;
    expect(request!.headers["x-automitra-event-id"]).toBe("usage.recorded:key-0");
    const expected = createHmac("sha256", SECRET)
      .update(`${request!.headers["x-automitra-timestamp"]}.${request!.body}`)
      .digest("hex");
    expect(request!.headers["x-automitra-signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(request!.body)).toEqual({
      id: "usage.recorded:key-0",
      type: "usage.recorded",
      createdAt: T0.toISOString(),
      data: { n: 0 },
    });
    expect((await rows())[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      lastStatusCode: 200,
    });
  });

  test("a failure is retried on schedule; call.ended gives up after the last retry", async () => {
    const { deliver, rows, answerWith, setClock } = await queueWith(["call.ended"]);
    answerWith(async () => ({ status: 503 }));
    let at = T0;
    for (const delay of RETRY_DELAYS_MS) {
      expect((await deliver()).retrying).toBe(1);
      const [row] = await rows();
      expect(row!.nextAttemptAt.getTime() - at.getTime()).toBe(delay);
      at = row!.nextAttemptAt;
      setClock(at);
    }
    expect((await deliver()).failed).toBe(1);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      attempts: 7,
      lastError: "HTTP 503",
    });
  });

  test("usage.recorded is never marked failed: it keeps retrying every 12 h", async () => {
    const { deliver, rows, answerWith, setClock } = await queueWith(["usage.recorded"]);
    answerWith(async () => {
      throw new Error("connection refused");
    });
    for (let attempt = 0; attempt < 10; attempt++) {
      await deliver();
      setClock((await rows())[0]!.nextAttemptAt);
    }
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", attempts: 10, lastError: "connection refused" });
    expect(row!.nextAttemptAt.getTime() - T0.getTime()).toBeGreaterThan(0);
  });

  test("a row leased by one pass is not sent by another", async () => {
    const { deliver, sent, answerWith } = await queueWith([
      "call.ended",
      "call.ended",
      "call.ended",
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answerWith(async () => {
      await gate;
      return { status: 200 };
    });
    const first = deliver();
    await Bun.sleep(50);
    const second = await deliver();
    release();
    expect(await first).toEqual({ delivered: 3, retrying: 0, failed: 0 });
    expect(second).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(sent).toHaveLength(3);
  });

  test("a disabled endpoint keeps its queue until enabled", async () => {
    const { db, endpoint, deliver, sent } = await queueWith(["call.ended"]);
    await db
      .update(webhookEndpoints)
      .set({ enabled: false })
      .where(eq(webhookEndpoints.id, endpoint.id));
    await deliver();
    expect(sent).toHaveLength(0);
    await db
      .update(webhookEndpoints)
      .set({ enabled: true })
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect((await deliver()).delivered).toBe(1);
  });

  test("the age of the oldest undelivered usage event, for the alert", async () => {
    const { db, deliver, answerWith } = await queueWith(["usage.recorded"]);
    answerWith(async () => ({ status: 500 }));
    await deliver();
    expect(await oldestUndeliveredUsageMs(db, new Date(T0.getTime() + 20 * 60_000))).toBe(
      20 * 60_000,
    );
  });

  test("pruning removes old finished rows and never a pending one", async () => {
    const { db, deliver, rows } = await queueWith(["call.ended", "usage.recorded"]);
    await deliver();
    await db.insert(webhookDeliveries).values({
      endpointId: (await rows())[0]!.endpointId,
      event: "usage.recorded",
      eventKey: "old-pending",
      payload: {},
      createdAt: T0,
    });
    expect(await pruneWebhookDeliveries(db, new Date(T0.getTime() + 31 * 24 * 3600_000))).toBe(2);
    expect((await rows()).map((row) => row.eventKey)).toEqual(["old-pending"]);
  });
});
