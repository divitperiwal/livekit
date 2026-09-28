/**
 * Sending events to customers' endpoints.
 *
 * `enqueue` writes deliveries inside the caller's transaction (see the schema
 * file for why); `deliverDue` is run by the background process and sends
 * whatever is due, retrying with backoff until it gives up.
 *
 * Every request is signed the same way tool calls are, so a customer
 * verifies both with one function:
 *
 *   X-Automitra-Timestamp: <unix seconds>
 *   X-Automitra-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">
 *
 * Signing the timestamp lets a receiver reject a captured request replayed
 * later. Delivery is at least once: a receiver should use the
 * `X-Automitra-Event-Id` header to ignore a repeat.
 */

import { createHmac } from "node:crypto";

import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { webhookDeliveries, webhookEndpoints } from "../db/schema";
import { safeRequest, type SafeRequest, type SafeResponse } from "./safe-fetch";
import { decryptSecret } from "./secrets";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const WEBHOOK_EVENTS = ["call.ended", "campaign.completed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Waits before each retry. Seven attempts over about a day: long enough to
 * ride out a customer's deploy or an outage, short enough that an event is
 * not delivered so late it is misleading.
 */
export const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000];

/** A claimed delivery is not picked up again for this long, in case a sender dies. */
const LEASE_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;

export function signPayload(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Queues an event for every endpoint of the organisation subscribed to it.
 *
 * Idempotent on `eventKey`: the same event queued twice -- a call finalised
 * twice -- is delivered once.
 */
export async function enqueue(
  tx: Tx | Database,
  orgId: string,
  event: WebhookEvent,
  eventKey: string,
  data: unknown,
): Promise<number> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.orgId, orgId),
        eq(webhookEndpoints.enabled, true),
        sql`${event} = any(${webhookEndpoints.events})`,
      ),
    );
  if (endpoints.length === 0) return 0;

  const payload = { id: eventKey, event, createdAt: new Date().toISOString(), data };
  const inserted = await tx
    .insert(webhookDeliveries)
    .values(endpoints.map((e) => ({ orgId, endpointId: e.id, event, eventKey, payload })))
    .onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.eventKey] })
    .returning({ id: webhookDeliveries.id });
  return inserted.length;
}

/** Queues a test event for one endpoint, whatever it subscribes to. */
export async function enqueuePing(db: Database, orgId: string, endpointId: string) {
  const eventKey = `ping:${crypto.randomUUID()}`;
  await db.insert(webhookDeliveries).values({
    orgId,
    endpointId,
    event: "ping",
    eventKey,
    payload: { id: eventKey, event: "ping", createdAt: new Date().toISOString(), data: { message: "It works." } },
  });
  return eventKey;
}

export type Sender = (url: string, request: SafeRequest) => Promise<SafeResponse>;

export interface DeliveryReport {
  delivered: number;
  retrying: number;
  failed: number;
}

/**
 * Sends what is due.
 *
 * Claimed by pushing `next_attempt_at` forward -- a lease -- rather than by
 * holding a row lock across the HTTP request, which could take seconds. Two
 * background processes therefore never send the same delivery at once, and a
 * process that dies mid-send leaves the delivery to be retried when the lease
 * runs out.
 */
export async function deliverDue(
  db: Database,
  now: Date = new Date(),
  send: Sender = safeRequest,
  limit = 25,
): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, retrying: 0, failed: 0 };

  const claimed = await db.transaction(async (tx) => {
    const due = await tx.execute<{ id: string }>(sql`
      select id from webhook_deliveries
      where status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    `);
    const ids = due.map((d) => d.id);
    if (ids.length === 0) return [];
    await tx
      .update(webhookDeliveries)
      .set({
        nextAttemptAt: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${webhookDeliveries.attempts} + 1`,
      })
      .where(inArray(webhookDeliveries.id, ids));
    return tx
      .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(inArray(webhookDeliveries.id, ids));
  });

  for (const { delivery, endpoint } of claimed) {
    const outcome = await attempt(delivery, endpoint, send);
    if (outcome.ok) {
      await db
        .update(webhookDeliveries)
        .set({ status: "delivered", deliveredAt: new Date(), lastStatusCode: outcome.status, lastError: null })
        .where(eq(webhookDeliveries.id, delivery.id));
      report.delivered += 1;
      continue;
    }

    const wait = RETRY_SCHEDULE_MS[delivery.attempts - 1];
    const giveUp = wait === undefined || !endpoint.enabled;
    await db
      .update(webhookDeliveries)
      .set({
        status: giveUp ? "failed" : "pending",
        nextAttemptAt: giveUp ? now : new Date(now.getTime() + wait!),
        lastStatusCode: outcome.status ?? null,
        lastError: outcome.error.slice(0, 500),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    if (giveUp) report.failed += 1;
    else report.retrying += 1;
  }

  return report;
}

type Attempt = { ok: true; status: number } | { ok: false; status?: number; error: string };

async function attempt(
  delivery: typeof webhookDeliveries.$inferSelect,
  endpoint: typeof webhookEndpoints.$inferSelect,
  send: Sender,
): Promise<Attempt> {
  if (!endpoint.enabled) return { ok: false, error: "the endpoint is disabled" };

  let secret: string;
  try {
    secret = await decryptSecret(endpoint.secretCiphertext);
  } catch (error) {
    return { ok: false, error: `the signing secret could not be read: ${(error as Error).message}` };
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const response = await send(endpoint.url, {
      method: "POST",
      body,
      timeoutMs: TIMEOUT_MS,
      maxBytes: 4096,
      headers: {
        "content-type": "application/json",
        "user-agent": "automitra-webhooks/1",
        "x-automitra-event": delivery.event,
        "x-automitra-event-id": delivery.eventKey,
        "x-automitra-delivery": delivery.id,
        "x-automitra-timestamp": timestamp,
        "x-automitra-signature": signPayload(secret, timestamp, body),
      },
    });
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `returned ${response.status}: ${response.body.slice(0, 200)}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Finished deliveries are kept thirty days, for the dashboard's delivery log. */
export async function pruneDeliveries(db: Database, now: Date): Promise<number> {
  const deleted = await db
    .delete(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.status, ["delivered", "failed"]),
        lte(webhookDeliveries.createdAt, new Date(now.getTime() - 30 * 24 * 3600_000)),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return deleted.length;
}
