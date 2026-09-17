/**
 * Phone numbers.
 *
 * The platform owns the Plivo account and the numbers on it, and assigns them
 * to organisations. That keeps one Plivo account and one LiveKit trunk pair
 * for the whole system: no per-tenant SIP provisioning, no per-tenant carrier
 * credentials to encrypt and rotate.
 *
 * `credentialsId` is the seam for changing that later. An enterprise customer
 * who insists on their own carrier account gets a row here pointing at their
 * credentials, and only then does per-tenant trunk provisioning become real
 * work. Until someone pays for it, the column stays null and nothing is built.
 */

import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { createdAt, id, orgs, updatedAt } from "./identity";

export const numberStatus = pgEnum("number_status", [
  "available",
  "assigned",
  "releasing",
]);

export const numberDirection = pgEnum("number_direction", [
  "inbound",
  "outbound",
  "both",
]);

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: id(),

    /**
     * Null while the number sits in the platform's unassigned pool. A number
     * with no organisation is inventory, not a tenant's.
     */
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),

    e164: text("e164").notNull(),
    provider: text("provider").notNull().default("plivo"),
    direction: numberDirection("direction").notNull().default("both"),
    status: numberStatus("status").notNull().default("available"),

    /** Which agent answers calls to this number. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),

    /**
     * The LiveKit dispatch rule provisioned for this number, so a reconciler
     * can tell what exists on the LiveKit side from what should exist here.
     */
    lkDispatchRuleId: text("lk_dispatch_rule_id"),

    /** Reserved for bring-your-own-carrier. See the file comment. */
    credentialsId: uuid("credentials_id"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * Globally unique, not unique per organisation. A phone number belongs to
     * exactly one tenant at a time, and this constraint is what makes a
     * routing mistake -- sending one customer's calls to another -- impossible
     * to represent rather than merely unlikely.
     */
    uniqueIndex("phone_numbers_e164_key").on(t.e164),
    index("phone_numbers_org_idx").on(t.orgId),
    index("phone_numbers_agent_idx").on(t.agentId),
  ],
);
