/**
 * Outbound campaigns: who to call, when it is allowed, and what happened.
 *
 * The dialer (`src/dialer.ts`) works these tables. It claims due contacts
 * under a per-campaign lock, dispatches the agent to place each call, and
 * reconciles each contact against its call record once that call has ended.
 * The worker never touches a contact directly -- it only writes the call
 * record, and the contact is moved on from that, so there is exactly one
 * place that decides whether a number is tried again.
 */

import {
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

import { agents } from "./agents";
import { calls } from "./calls";
import { createdAt, id, orgs, updatedAt, users } from "./identity";
import { phoneNumbers } from "./telephony";

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

    /**
     * Why the campaign is in its status, when the platform put it there
     * rather than a person: "out of credit", "caller ID number released".
     */
    statusReason: text("status_reason"),

    /**
     * The number calls are placed from. Must be one of the organisation's own
     * and allowed to dial out; checked when the campaign starts, and again by
     * the carrier, which rejects a caller ID that is not on the trunk.
     */
    fromNumberId: uuid("from_number_id").references(() => phoneNumbers.id, {
      onDelete: "set null",
    }),

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

    /**
     * When the current attempt was dispatched. A contact still `dialing` long
     * after this with no call record means the attempt never reached a
     * worker, and is counted as a failed attempt rather than waited on forever.
     */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),

    /** How the last attempt went -- the call's status -- for display. */
    lastOutcome: text("last_outcome"),

    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A number is on a campaign once. Uploading the same list twice, or a
    // list with a duplicate row, must not call someone twice.
    uniqueIndex("campaign_contacts_campaign_e164_key").on(t.campaignId, t.e164),
    index("campaign_contacts_campaign_status_idx").on(t.campaignId, t.status),
    // The dialer's hot query: what is due to be called next.
    index("campaign_contacts_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("campaign_contacts_org_idx").on(t.orgId),
  ],
);

/**
 * Numbers an organisation must not call.
 *
 * Checked when a contact is claimed for dialling, not only when it is
 * uploaded: someone who asks not to be called on Monday must not be called by
 * a campaign whose list was uploaded last week.
 *
 * Per organisation, because a do-not-call request is made to a business. The
 * national DND registry is a different list with its own lookup, and is not
 * this table.
 */
export const suppressedNumbers = pgTable(
  "suppressed_numbers",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    e164: text("e164").notNull(),

    /** How it got here: "call" (asked the agent), "manual", "upload". */
    source: text("source").notNull(),
    reason: text("reason"),

    /** The call in which the request was made, when there was one. */
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("suppressed_numbers_org_e164_key").on(t.orgId, t.e164)],
);
