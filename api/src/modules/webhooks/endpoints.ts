import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { onlyRow, type Database } from "../../db/database";
import { orgs, webhookEndpoints } from "../../db/schema";
import type { SecretBox } from "../secrets/secret-box";
import type { WebhookEvent } from "./enqueue";

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "call.ended",
  "usage.recorded",
  "account.credit_low",
];

/** The signing secret, shown once. Receivers verify `X-Automitra-Signature` with it. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export async function addWebhookEndpoint(
  db: Database,
  secretBox: SecretBox,
  input: {
    accountId: string;
    orgId: string | null;
    url: string;
    events: WebhookEvent[];
    description: string | null;
  },
) {
  const secret = generateWebhookSecret();
  const endpoint = await db
    .insert(webhookEndpoints)
    .values({
      accountId: input.accountId,
      orgId: input.orgId,
      url: input.url,
      events: input.events,
      description: input.description,
      secretCiphertext: secretBox.encrypt(secret),
    })
    .returning()
    .then(onlyRow);
  return { endpoint: endpoint, secret };
}

export function listWebhookEndpoints(db: Database, accountId: string) {
  return db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      org: orgs.externalId,
      enabled: webhookEndpoints.enabled,
      createdAt: webhookEndpoints.createdAt,
    })
    .from(webhookEndpoints)
    .leftJoin(orgs, eq(orgs.id, webhookEndpoints.orgId))
    .where(eq(webhookEndpoints.accountId, accountId))
    .orderBy(asc(webhookEndpoints.createdAt));
}

/** A disabled endpoint keeps its queue; enabling it again delivers the backlog. */
export async function setWebhookEndpointEnabled(
  db: Database,
  accountId: string,
  endpointId: string,
  enabled: boolean,
): Promise<boolean> {
  const updated = await db
    .update(webhookEndpoints)
    .set({ enabled })
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.accountId, accountId)))
    .returning({ id: webhookEndpoints.id });
  return updated.length > 0;
}
