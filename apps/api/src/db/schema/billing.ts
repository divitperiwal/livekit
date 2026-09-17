/**
 * Metering and billing.
 *
 * Three ideas hold this together.
 *
 * Cost and price are separate numbers, stored on every usage record. Cost is
 * what the platform paid its providers; price is what the customer is charged.
 * Margin per call is something you will want from the first week and cannot
 * reconstruct afterwards from a single blended figure.
 *
 * Every write is idempotent on an explicit key. A call can be finalised twice
 * -- the session close and the shutdown callback both fire, webhooks get
 * redelivered -- and double-billing a customer is not a recoverable mistake.
 *
 * The ledger is append-only and `org_balances` is derived from it. The balance
 * can always be rebuilt by summing the ledger, which is what makes a
 * disagreement between them diagnosable rather than mysterious.
 */

import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { calls } from "./calls";
import { createdAt, id, orgs } from "./identity";

/**
 * Rate cards, versioned by effective date.
 *
 * A null `orgId` is the platform default that every organisation falls back
 * to. A row with an `orgId` overrides it for that customer, which is how a
 * negotiated enterprise price is represented.
 *
 * `rates` holds both sides: what each provider charges per unit, and the terms
 * the customer is sold on. Keeping them in one versioned row means a historical
 * invoice can always be recomputed exactly as it was issued.
 */
export const rateCards = pgTable(
  "rate_cards",
  {
    id: id(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rates: jsonb("rates").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("rate_cards_org_effective_idx").on(t.orgId, t.effectiveFrom)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),

    /**
     * `call:<id>:v1`. The version suffix exists so a deliberate recompute --
     * after a rate correction, say -- can write a second record and a
     * compensating ledger entry, rather than silently overwriting history.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /** The day this usage belongs to, for rollups and invoice periods. */
    periodStart: date("period_start").notNull(),

    billableSeconds: integer("billable_seconds").notNull().default(0),

    /** Measured usage, kept so a disputed charge can be traced to its inputs. */
    sttSeconds: numeric("stt_seconds", { precision: 12, scale: 3 }).notNull().default("0"),
    ttsCharacters: bigint("tts_characters", { mode: "number" }).notNull().default(0),
    llmPromptTokens: bigint("llm_prompt_tokens", { mode: "number" }).notNull().default(0),
    llmCachedTokens: bigint("llm_cached_tokens", { mode: "number" }).notNull().default(0),
    llmCompletionTokens: bigint("llm_completion_tokens", { mode: "number" })
      .notNull()
      .default(0),
    pstnSeconds: integer("pstn_seconds").notNull().default(0),

    costSttInr: numeric("cost_stt_inr", { precision: 12, scale: 6 }),
    costTtsInr: numeric("cost_tts_inr", { precision: 12, scale: 6 }),
    costLlmInr: numeric("cost_llm_inr", { precision: 12, scale: 6 }),

    /**
     * The carrier's charge, which is often the largest single component and is
     * the one the platform does not control. Written as an estimate when the
     * call ends and corrected later from the carrier's own records.
     */
    costPstnInr: numeric("cost_pstn_inr", { precision: 12, scale: 6 }),
    costTotalInr: numeric("cost_total_inr", { precision: 12, scale: 6 }),

    priceInr: numeric("price_inr", { precision: 12, scale: 6 }),

    rateCardId: uuid("rate_card_id").references(() => rateCards.id, {
      onDelete: "set null",
    }),

    /**
     * Set when the cost could not be computed -- an unpriced model, a missing
     * rate. The record is still written: losing a usage record because a rate
     * card was behind is a revenue leak, and a flagged row can be repriced.
     */
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("usage_records_idempotency_key").on(t.idempotencyKey),
    uniqueIndex("usage_records_call_key").on(t.callId),
    index("usage_records_org_period_idx").on(t.orgId, t.periodStart),
    index("usage_records_review_idx").on(t.needsReview),
  ],
);

export const ledgerKind = pgEnum("ledger_kind", [
  "usage",
  "topup",
  "adjustment",
  "refund",
]);

/**
 * Append-only money movement. Never updated, never deleted.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: ledgerKind("kind").notNull(),

    /** Negative for usage, positive for a top-up. */
    amountInr: numeric("amount_inr", { precision: 14, scale: 4 }).notNull(),

    usageRecordId: uuid("usage_record_id").references(() => usageRecords.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ledger_entries_idempotency_key").on(t.idempotencyKey),
    index("ledger_entries_org_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * The current balance, as a cache of the ledger.
 *
 * Read on every call start to decide whether the organisation may place one,
 * which is why it is a single row to look up rather than a sum over the
 * ledger. It must only ever be updated in the same transaction as the ledger
 * entry that justifies it.
 */
export const orgBalances = pgTable("org_balances", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  balanceInr: numeric("balance_inr", { precision: 14, scale: 4 })
    .notNull()
    .default("0"),
  /** How far below zero this organisation is allowed to go. */
  creditLimitInr: numeric("credit_limit_inr", { precision: 14, scale: 4 })
    .notNull()
    .default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
