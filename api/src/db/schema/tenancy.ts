import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { at, createdAt, id, inr, updatedAt } from "./columns";

export const accountStatus = pgEnum("account_status", ["active", "suspended"]);

/** An API client we issue keys to (automitra, later outside clients). Accounts are charged, not orgs. */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    status: accountStatus("status").notNull().default("active"),
    /** Postpaid kill switch: no new call once unpaid usage reaches it. Null = no cap. */
    creditCapInr: inr("credit_cap_inr"),
    /** Stops a leaked key or runaway client the same day. Null = no daily cap. */
    dailyCapInr: inr("daily_cap_inr"),
    /** The account's own per-org wallet check. Null = not asked. */
    balanceCheckUrl: text("balance_check_url"),
    balanceCheckSecretCiphertext: text("balance_check_secret_ciphertext"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("accounts_credit_cap_positive", sql`${t.creditCapInr} is null or ${t.creditCapInr} > 0`),
    check("accounts_daily_cap_positive", sql`${t.dailyCapInr} is null or ${t.dailyCapInr} > 0`),
    check(
      "accounts_balance_check_has_secret",
      sql`${t.balanceCheckUrl} is null or ${t.balanceCheckSecretCiphertext} is not null`,
    ),
  ],
);

/** `orgs:*` covers orgs, agents, versions and an org's numbers; `calls:*` placing and reading calls. */
export const apiKeyScopes = ["orgs:read", "orgs:write", "calls:read", "calls:write"] as const;

/** Issued only from the ops CLI. Only the SHA-256 of the key is stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Plaintext start of the key, for lookup and for telling keys apart. */
    prefix: text("prefix").notNull().unique(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    /** Live calls this key may have at once (queued, ringing or in progress). */
    maxConcurrentCalls: integer("max_concurrent_calls").notNull().default(1),
    lastUsedAt: at("last_used_at"),
    expiresAt: at("expires_at"),
    revokedAt: at("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_keys_account_idx").on(t.accountId),
    check("api_keys_max_concurrent_calls_positive", sql`${t.maxConcurrentCalls} > 0`),
  ],
);

export const orgStatus = pgEnum("org_status", ["active", "suspended"]);

/** A business of one account, named by the account's own id for it. Soft-deleted only. */
export const orgs = pgTable(
  "orgs",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    status: orgStatus("status").notNull().default("active"),
    recordCalls: boolean("record_calls").notNull().default(false),
    recordingRetentionDays: integer("recording_retention_days").notNull().default(30),
    redactPii: boolean("redact_pii").notNull().default(false),
    deletedAt: at("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("orgs_account_external_id_key").on(t.accountId, t.externalId),
    check("orgs_retention_positive", sql`${t.recordingRetentionDays} > 0`),
  ],
);
