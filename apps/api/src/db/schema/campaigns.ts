/**
 * Outbound campaigns.
 *
 * Tables only, deliberately. The dialer itself -- pacing, retry backoff,
 * do-not-call handling, concurrency limits, answering-machine detection -- is
 * a genuinely hard subsystem and is not built yet.
 *
 * They are defined now because two empty tables cost nothing and save a
 * migration against a table that by then has call records pointing at it.
 */

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { calls } from "./calls";
import { createdAt, id, orgs, updatedAt } from "./identity";

export const campaignStatus = pgEnum("campaign_status", [
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
]);

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    status: campaignStatus("status").notNull().default("draft"),

    /** Calling windows and timezone: when it is legal and polite to dial. */
    schedule: jsonb("schedule").notNull().default({}),

    /** How many calls this campaign may have in flight at once. */
    concurrency: integer("concurrency").notNull().default(5),

    retryPolicy: jsonb("retry_policy").notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_org_idx").on(t.orgId)],
);

export const contactStatus = pgEnum("contact_status", [
  "pending",
  "dialing",
  "completed",
  "failed",
  "exhausted",
  "suppressed",
]);

export const campaignContacts = pgTable(
  "campaign_contacts",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    e164: text("e164").notNull(),

    /** Per-contact substitutions available to the prompt: name, order id. */
    variables: jsonb("variables").notNull().default({}),

    status: contactStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastCallId: uuid("last_call_id").references(() => calls.id, {
      onDelete: "set null",
    }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("campaign_contacts_campaign_status_idx").on(t.campaignId, t.status),
    // The dialer's hot query: what is due to be called next.
    index("campaign_contacts_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("campaign_contacts_org_idx").on(t.orgId),
  ],
);
