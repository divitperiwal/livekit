/**
 * Webhooks: telling a customer's systems what happened, as it happens.
 *
 * Delivery goes through an outbox. An event is written as a delivery row in
 * the same transaction as the change it reports -- a call finalised, a
 * campaign completed -- and a background loop sends it. That way a call is
 * never recorded without its event, an event is never sent for a call that
 * rolled back, and an endpoint that is down delays delivery instead of losing
 * it.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, id, orgs, updatedAt } from "./identity";

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),

    /**
     * The signing secret, encrypted with `SECRETS_KEY`. Shown once when the
     * endpoint is created; the receiver uses it to check each request came
     * from here.
     */
    secretCiphertext: text("secret_ciphertext").notNull(),

    /** Which events to send. */
    events: text("events").array().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhook_endpoints_org_idx").on(t.orgId)],
);

export const deliveryStatus = pgEnum("webhook_delivery_status", ["pending", "delivered", "failed"]);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),

    event: text("event").notNull(),

    /**
     * What the event is about, e.g. `call.ended:<call id>`. Unique per
     * endpoint, so reporting the same thing twice -- a call finalised twice,
     * which is normal -- sends it once.
     */
    eventKey: text("event_key").notNull(),
    payload: jsonb("payload").notNull(),

    status: deliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_endpoint_event_key").on(t.endpointId, t.eventKey),
    // The delivery loop's query: what is due.
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
  ],
);
