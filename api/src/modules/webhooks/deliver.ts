import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, min, or, sql } from "drizzle-orm";
import type { Database } from "../../db/database";
import { webhookDeliveries, webhookEndpoints } from "../../db/schema";
import type { SecretBox } from "../secrets/secret-box";
import { errorMessage } from "../../error-message";
import { safePost, type SafePostOptions } from "./safe-fetch";

const MINUTE = 60_000;
/** After attempt n fails, wait RETRY_DELAYS_MS[n - 1]. Past the end, a delivery fails (except usage.recorded). */
export const RETRY_DELAYS_MS = [1, 5, 30, 120, 360, 720].map((minutes) => minutes * MINUTE);
export const LEASE_MS = 2 * MINUTE;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** The account debits from usage.recorded: alert when one waits longer than this. */
export const USAGE_UNDELIVERED_ALERT_MS = 15 * MINUTE;
const PARALLEL_SENDS = 10;

export type WebhookPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

export type DeliveryDependencies = {
  db: Database;
  secretBox: SecretBox;
  /** Default: `safePost` through the SSRF guard. */
  post?: WebhookPost;
  safePostOptions?: Partial<SafePostOptions>;
  now?: () => Date;
  batchSize?: number;
};

/** `X-Automitra-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`. */
export function signatureHeader(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

type Claimed = typeof webhookDeliveries.$inferSelect & { url: string; secretCiphertext: string };

/** Leases due rows so no other process sends them; `SKIP LOCKED` lets two processes share the queue. */
async function claimDue(db: Database, now: Date, limit: number): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          eq(webhookEndpoints.enabled, true),
          lte(webhookDeliveries.nextAttemptAt, now),
          or(isNull(webhookDeliveries.leasedUntil), lt(webhookDeliveries.leasedUntil, now)),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { of: webhookDeliveries, skipLocked: true });
    if (due.length === 0) return [];
    const ids = due.map((row) => row.id);
    await tx
      .update(webhookDeliveries)
      .set({ leasedUntil: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(webhookDeliveries.id, ids));
    return tx
      .select({
        delivery: webhookDeliveries,
        url: webhookEndpoints.url,
        secretCiphertext: webhookEndpoints.secretCiphertext,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(inArray(webhookDeliveries.id, ids))
      .then((rows) =>
        rows.map((row) => ({
          ...row.delivery,
          url: row.url,
          secretCiphertext: row.secretCiphertext,
        })),
      );
  });
}

export const eventId = (delivery: { event: string; eventKey: string }) =>
  `${delivery.event}:${delivery.eventKey}`;

type DeliveryResult = "delivered" | "retrying" | "failed";
type Attempt = { statusCode: number | null; error: string | null };

/** POSTs the signed event once. `error` is null on a 2xx. */
async function attemptDelivery(
  deps: DeliveryDependencies,
  post: WebhookPost,
  delivery: Claimed,
  now: Date,
): Promise<Attempt> {
  const body = JSON.stringify({
    id: eventId(delivery),
    type: delivery.event,
    createdAt: delivery.createdAt.toISOString(),
    data: delivery.payload,
  });
  const timestamp = String(Math.floor(now.getTime() / 1000));

  try {
    const secret = deps.secretBox.decrypt(delivery.secretCiphertext);
    const { status } = await post(delivery.url, body, {
      "x-automitra-timestamp": timestamp,
      "x-automitra-signature": signatureHeader(secret, timestamp, body),
      "x-automitra-event-id": eventId(delivery),
      "user-agent": "automitra-webhooks/1",
    });
    const succeeded = status >= 200 && status < 300;
    return { statusCode: status, error: succeeded ? null : `HTTP ${status}` };
  } catch (error) {
    return { statusCode: null, error: errorMessage(error) };
  }
}

/** usage.recorded is never given up on: the account debits from it. */
function givesUpAfter(delivery: Claimed, attempts: number): boolean {
  return delivery.event !== "usage.recorded" && attempts > RETRY_DELAYS_MS.length;
}

function retryDelayMs(attempts: number): number {
  const lastDelay = RETRY_DELAYS_MS.length - 1;
  return RETRY_DELAYS_MS[Math.min(attempts - 1, lastDelay)]!;
}

async function sendOne(
  deps: DeliveryDependencies,
  post: WebhookPost,
  delivery: Claimed,
  now: Date,
): Promise<DeliveryResult> {
  const { statusCode, error } = await attemptDelivery(deps, post, delivery, now);
  const attempts = delivery.attempts + 1;

  if (error === null) {
    await deps.db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts,
        deliveredAt: now,
        lastStatusCode: statusCode,
        lastError: null,
        leasedUntil: null,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return "delivered";
  }

  const givesUp = givesUpAfter(delivery, attempts);
  await deps.db
    .update(webhookDeliveries)
    .set({
      status: givesUp ? "failed" : "pending",
      attempts,
      lastStatusCode: statusCode,
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      leasedUntil: null,
    })
    .where(eq(webhookDeliveries.id, delivery.id));
  return givesUp ? "failed" : "retrying";
}

/** One pass over the due queue, sending up to PARALLEL_SENDS at a time. Returns counts for the log. */
export async function deliverDueWebhooks(deps: DeliveryDependencies) {
  const now = (deps.now ?? (() => new Date()))();
  const safePostOptions = { timeoutMs: DELIVERY_TIMEOUT_MS, ...deps.safePostOptions };
  const post: WebhookPost =
    deps.post ?? ((url, body, headers) => safePost(url, body, headers, safePostOptions));

  const claimed = await claimDue(deps.db, now, deps.batchSize ?? 50);
  const counts: Record<DeliveryResult, number> = { delivered: 0, retrying: 0, failed: 0 };
  for (let i = 0; i < claimed.length; i += PARALLEL_SENDS) {
    const batch = claimed.slice(i, i + PARALLEL_SENDS);
    const results = await Promise.all(batch.map((delivery) => sendOne(deps, post, delivery, now)));
    for (const result of results) counts[result] += 1;
  }
  return counts;
}

/** How long the oldest undelivered usage.recorded has waited, or null when none waits. */
export async function oldestUndeliveredUsageMs(db: Database, now: Date): Promise<number | null> {
  const [row] = await db
    .select({ oldest: min(webhookDeliveries.createdAt) })
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.event, "usage.recorded"), eq(webhookDeliveries.status, "pending")),
    );
  return row?.oldest ? now.getTime() - new Date(row.oldest).getTime() : null;
}

/** Old delivered and failed rows go; pending ones never do. */
export async function pruneWebhookDeliveries(
  db: Database,
  now: Date,
  keepDays = 30,
): Promise<number> {
  const pruned = await db
    .delete(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.status, ["delivered", "failed"]),
        lt(
          webhookDeliveries.createdAt,
          sql`${now.toISOString()}::timestamptz - make_interval(days => ${keepDays})`,
        ),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return pruned.length;
}
