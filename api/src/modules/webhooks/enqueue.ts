import { and, arrayContains, eq, isNull, or } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/database";
import { webhookDeliveries, webhookEndpoints, type webhookEvent } from "../../db/schema";

export type WebhookEvent = (typeof webhookEvent.enumValues)[number];

/**
 * Queues one event for every enabled endpoint of the account subscribed to it (all its
 * orgs, or this org only). Call inside the transaction that made the change, so the
 * event exists exactly when the change does. Idempotent on (endpoint, event, eventKey).
 */
export async function enqueueWebhook(
  tx: DatabaseTransaction,
  event: {
    accountId: string;
    orgId: string | null;
    type: WebhookEvent;
    key: string;
    payload: Record<string, unknown>;
  },
): Promise<number> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.accountId, event.accountId),
        eq(webhookEndpoints.enabled, true),
        arrayContains(webhookEndpoints.events, [event.type]),
        event.orgId === null
          ? isNull(webhookEndpoints.orgId)
          : or(isNull(webhookEndpoints.orgId), eq(webhookEndpoints.orgId, event.orgId)),
      ),
    );
  if (endpoints.length === 0) return 0;
  const queued = await tx
    .insert(webhookDeliveries)
    .values(
      endpoints.map(({ id }) => ({
        endpointId: id,
        event: event.type,
        eventKey: event.key,
        payload: event.payload,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return queued.length;
}
