/**
 * Organisations, users, membership and API keys.
 *
 * The organisation is the tenant boundary: every other table in the schema
 * carries an `orgId`, and every query is scoped by it. A missed scope here is
 * the bug class that ends a business, so the column is never nullable except
 * where a row is deliberately shared across tenants (a platform-default rate
 * card, an unassigned phone number).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Case-insensitive text, for email addresses.
 *
 * Postgres has no native case-insensitive type, and comparing `lower(email)`
 * at every call site is a rule that eventually gets forgotten. `citext` makes
 * the database enforce it, so a unique index on the column actually prevents
 * Alice@ and alice@ existing as two accounts.
 */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** Shared column shapes, so timestamps and ids are consistent everywhere. */
export const id = () => uuid("id").primaryKey().defaultRandom();
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const orgPlan = pgEnum("org_plan", ["trial", "starter", "growth", "enterprise"]);
export const orgStatus = pgEnum("org_status", ["active", "suspended", "closed"]);

export const orgs = pgTable(
  "orgs",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: orgPlan("plan").notNull().default("trial"),
    status: orgStatus("status").notNull().default("active"),

    /**
     * Recordings are off by default and stay off until someone opts in.
     * Recording a phone call needs a consent basis, and that is a decision the
     * customer has to make deliberately rather than inherit from a default.
     */
    recordCalls: boolean("record_calls").notNull().default(false),
    recordingRetentionDays: integer("recording_retention_days").notNull().default(30),

    /**
     * Mask phone numbers, emails, card numbers, Aadhaar and PAN in stored
     * transcripts and summaries. Applied as they are written, so the
     * unmasked text never reaches the database at all.
     */
    redactPii: boolean("redact_pii").notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("orgs_slug_key").on(t.slug)],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: citext("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const memberRole = pgEnum("member_role", [
  "owner",
  "admin",
  "developer",
  "viewer",
]);

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("viewer"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("org_members_pkey").on(t.orgId, t.userId),
    index("org_members_user_idx").on(t.userId),
  ],
);

/**
 * Invitations to join an organisation.
 *
 * The link carries a random token; only its hash is stored, like an API key.
 * Accepting creates the account if there is none, and adds the membership.
 */
export const invites = pgTable(
  "invites",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    role: memberRole("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_hash_key").on(t.tokenHash), index("invites_org_idx").on(t.orgId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),

    /**
     * The key is shown once, at creation, and only its hash is kept. The
     * prefix is stored separately so the dashboard can display
     * `ak_live_7f3c...` and so a lookup can find the one candidate row by
     * prefix and then verify the hash -- rather than reading every key in the
     * table and comparing each one.
     */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),

    scopes: text("scopes").array().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_key").on(t.prefix),
    index("api_keys_org_idx").on(t.orgId),
  ],
);
