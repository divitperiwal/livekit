import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { at, createdAt, id, updatedAt } from "./columns";
import { accounts, orgs } from "./tenancy";

export const webhookEvent = pgEnum("webhook_event", [
  "call.ended",
  "usage.recorded",
  "account.credit_low",
]);

/** Owned by the account; `org_id` narrows it to one org's events. */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    secretCiphertext: text("secret_ciphertext").notNull(),
    events: webhookEvent("events").array().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhook_endpoints_account_idx").on(t.accountId)],
);

export const deliveryStatus = pgEnum("webhook_delivery_status", ["pending", "delivered", "failed"]);

/**
 * Queued in the same transaction as the change. At-least-once; receivers dedupe on
 * `X-Automitra-Event-Id`. `usage.recorded` is retried until delivered and can never be
 * marked failed: the account debits its customers' wallets from it.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "restrict" }),
    event: webhookEvent("event").notNull(),
    /** The id the event is about (call, usage record); unique per endpoint and event. */
    eventKey: text("event_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: at("next_attempt_at").notNull().defaultNow(),
    /** A background process owns the row until then (no double send across processes). */
    leasedUntil: at("leased_until"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    deliveredAt: at("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("webhook_deliveries_endpoint_event_key").on(t.endpointId, t.event, t.eventKey),
    index("webhook_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      "webhook_deliveries_usage_never_fails",
      sql`${t.event} <> 'usage.recorded' or ${t.status} <> 'failed'`,
    ),
  ],
);
