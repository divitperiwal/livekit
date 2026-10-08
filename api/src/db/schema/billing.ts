import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { calls } from "./calls";
import { at, costInr, createdAt, id, inr } from "./columns";
import { accounts, orgs } from "./tenancy";

/** Global (account null) or per account, effective-dated. `rates` is validated by its Zod schema. */
export const rateCards = pgTable(
  "rate_cards",
  {
    id: id(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    rates: jsonb("rates").$type<Record<string, unknown>>().notNull(),
    effectiveFrom: at("effective_from").notNull(),
    effectiveTo: at("effective_to"),
    createdAt: createdAt(),
  },
  (t) => [
    index("rate_cards_account_effective_idx").on(t.accountId, t.effectiveFrom),
    check(
      "rate_cards_effective_order",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * One per call, written by finalize (idempotent on `call_id`). Cost and price are kept
 * apart. An unpriced model still writes the row, flagged `needs_review` (guarantee 11).
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "restrict" }),
    callId: uuid("call_id")
      .notNull()
      .unique()
      .references(() => calls.id, { onDelete: "restrict" }),
    rateCardId: uuid("rate_card_id").references(() => rateCards.id, { onDelete: "restrict" }),
    billableSeconds: integer("billable_seconds").notNull(),
    pstnSeconds: integer("pstn_seconds").notNull(),
    sttSeconds: numeric("stt_seconds", { precision: 12, scale: 3 }).notNull(),
    ttsCharacters: integer("tts_characters").notNull(),
    llmPromptTokens: integer("llm_prompt_tokens").notNull(),
    llmCachedTokens: integer("llm_cached_tokens").notNull(),
    llmCompletionTokens: integer("llm_completion_tokens").notNull(),
    sttModel: text("stt_model").notNull(),
    ttsModel: text("tts_model").notNull(),
    llmModel: text("llm_model").notNull(),
    sttCostInr: costInr("stt_cost_inr").notNull(),
    ttsCostInr: costInr("tts_cost_inr").notNull(),
    llmCostInr: costInr("llm_cost_inr").notNull(),
    pstnCostInr: costInr("pstn_cost_inr").notNull(),
    totalCostInr: costInr("total_cost_inr").notNull(),
    priceInr: inr("price_inr").notNull(),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_records_account_created_idx").on(t.accountId, t.createdAt),
    index("usage_records_org_created_idx").on(t.orgId, t.createdAt),
    check(
      "usage_records_review_has_reason",
      sql`not ${t.needsReview} or ${t.reviewReason} is not null`,
    ),
    check("usage_records_price_nonnegative", sql`${t.priceInr} >= 0`),
  ],
);

export const ledgerKind = pgEnum("ledger_kind", ["usage", "payment", "adjustment"]);

/**
 * Append-only (guarantee 10; a trigger rejects update and delete). Amounts are positive
 * for usage and payments; an adjustment credits when positive and debits when negative.
 * Unpaid = usage − payments − adjustments.
 */
export const accountLedger = pgTable(
  "account_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    kind: ledgerKind("kind").notNull(),
    amountInr: inr("amount_inr").notNull(),
    usageRecordId: uuid("usage_record_id")
      .unique()
      .references(() => usageRecords.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** The payment's own reference (bank transfer, invoice). */
    reference: text("reference"),
    description: text("description"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("account_ledger_account_idx").on(t.accountId, t.kind),
    check(
      "account_ledger_usage_links_record",
      sql`(${t.kind} = 'usage') = (${t.usageRecordId} is not null)`,
    ),
    check(
      "account_ledger_amount_sign",
      sql`case ${t.kind} when 'usage' then ${t.amountInr} >= 0 when 'payment' then ${t.amountInr} > 0 else ${t.amountInr} <> 0 end`,
    ),
  ],
);
