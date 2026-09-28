/**
 * What a call cost, and what it is sold for.
 *
 * Two numbers, kept apart on purpose. `cost` is what the platform paid its
 * providers -- Sarvam for the models, the carrier for the minutes. `price` is
 * what the customer is charged. Margin per call is something you want from the
 * first week and cannot reconstruct afterwards from a single blended figure.
 *
 * Selling per minute rather than cost-plus is the default because a customer
 * can forecast it, and because it means moving to a cheaper model is a margin
 * improvement rather than a price cut passed straight through.
 *
 * Nothing here throws. An unpriced model or a missing rate card produces a
 * record flagged for review, never no record at all: losing a usage row is
 * revenue that silently never existed, whereas a flagged row can be repriced
 * once the card catches up.
 */

import { and, desc, eq, isNull, or, gte, lte, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { rateCards } from "../db/schema";

export interface Rates {
  cost: {
    sttInrPerMin: Record<string, number>;
    ttsInrPerChar: Record<string, number>;
    llmInrPerMtok: Record<string, { input: number; output: number }>;
    llmInrCachedPerMtok: Record<string, number>;
    pstnInrPerMin: Record<string, number>;
  };
  sell: {
    mode: "per_minute" | "cost_plus";
    perMinuteInr?: number;
    markupMultiplier?: number;
    minimumSeconds: number;
    incrementSeconds: number;
    includedMinutesPerMonth?: number;
  };
}

export interface UsageInput {
  sttSeconds: number;
  ttsCharacters: number;
  llmPromptTokens: number;
  llmCachedTokens: number;
  llmCompletionTokens: number;
  sttModel?: string | null;
  ttsModel?: string | null;
  llmModel?: string | null;
  /** Wall-clock seconds the line was open, for PSTN and per-minute selling. */
  durationSeconds: number;
  /** Destination, so the carrier rate can be chosen by prefix. */
  toNumber?: string | null;
  /**
   * Whether the call went over a phone line at all. False for a browser test
   * call, which has no carrier leg to pay for. Defaults to true: an unknown
   * number on a real call is still charged, at the fallback rate.
   */
  phoneLeg?: boolean;
}

export interface Priced {
  billableSeconds: number;
  costSttInr: number | null;
  costTtsInr: number | null;
  costLlmInr: number | null;
  costPstnInr: number | null;
  costTotalInr: number | null;
  priceInr: number | null;
  rateCardId: string | null;
  needsReview: boolean;
  reviewReason: string | null;
}

/**
 * The card in force for an organisation.
 *
 * A row with this org wins over the platform default, and among those the most
 * recently effective one wins. Cards are versioned by date rather than edited,
 * so a historical invoice can always be recomputed exactly as it was issued.
 */
export async function rateCardFor(db: Database, orgId: string) {
  const now = new Date();
  const rows = await db
    .select()
    .from(rateCards)
    .where(
      and(
        or(eq(rateCards.orgId, orgId), isNull(rateCards.orgId)),
        lte(rateCards.effectiveFrom, now),
        or(isNull(rateCards.effectiveTo), gte(rateCards.effectiveTo, now)),
      ),
    )
    // Org-specific before platform default, then newest first.
    .orderBy(sql`${rateCards.orgId} nulls last`, desc(rateCards.effectiveFrom))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Rounds a duration up to the billing increment, respecting the minimum.
 *
 * A thirty-second minimum is standard for voice and is what makes a flurry of
 * very short calls worth carrying.
 */
export function billableSeconds(
  durationSeconds: number,
  { minimumSeconds, incrementSeconds }: Pick<Rates["sell"], "minimumSeconds" | "incrementSeconds">,
): number {
  const seconds = Math.max(durationSeconds, minimumSeconds);
  const step = Math.max(incrementSeconds, 1);
  return Math.ceil(seconds / step) * step;
}

/** The carrier's per-minute rate for a destination, by longest matching prefix. */
export function pstnRateFor(
  toNumber: string | null | undefined,
  rates: Record<string, number>,
): number {
  if (toNumber) {
    let best: { prefix: string; rate: number } | null = null;
    for (const [prefix, rate] of Object.entries(rates)) {
      if (prefix === "default") continue;
      if (toNumber.startsWith(prefix)) {
        if (!best || prefix.length > best.prefix.length) {
          best = { prefix, rate };
        }
      }
    }
    if (best) return best.rate;
  }
  return rates.default ?? 0;
}

/**
 * Prices one call.
 *
 * The cached-token subtraction is the subtle part: providers report cached
 * tokens *within* the prompt total rather than alongside it, so charging both
 * at the fresh rate would overbill every long call.
 */
export function priceCall(
  usage: UsageInput,
  card: { id: string; rates: unknown } | null,
): Priced {
  const billable = card
    ? billableSeconds(usage.durationSeconds, (card.rates as Rates).sell)
    : usage.durationSeconds;

  if (!card) {
    return {
      billableSeconds: billable,
      costSttInr: null,
      costTtsInr: null,
      costLlmInr: null,
      costPstnInr: null,
      costTotalInr: null,
      priceInr: null,
      rateCardId: null,
      needsReview: true,
      reviewReason: "no rate card in force for this organisation",
    };
  }

  const rates = card.rates as Rates;
  const missing: string[] = [];

  const sttRate = rates.cost.sttInrPerMin[usage.sttModel ?? ""];
  if (sttRate === undefined) missing.push(`stt:${usage.sttModel}`);

  const ttsRate = rates.cost.ttsInrPerChar[usage.ttsModel ?? ""];
  if (ttsRate === undefined) missing.push(`tts:${usage.ttsModel}`);

  const llmRate = rates.cost.llmInrPerMtok[usage.llmModel ?? ""];
  if (llmRate === undefined) missing.push(`llm:${usage.llmModel}`);

  const cachedRate =
    rates.cost.llmInrCachedPerMtok[usage.llmModel ?? ""] ?? llmRate?.input;

  const costStt = sttRate === undefined ? null : (usage.sttSeconds / 60) * sttRate;
  const costTts = ttsRate === undefined ? null : usage.ttsCharacters * ttsRate;

  let costLlm: number | null = null;
  if (llmRate !== undefined) {
    // Cached tokens are a subset of the prompt total, not an addition.
    const fresh = Math.max(0, usage.llmPromptTokens - usage.llmCachedTokens);
    costLlm =
      (fresh * llmRate.input +
        usage.llmCachedTokens * (cachedRate ?? llmRate.input) +
        usage.llmCompletionTokens * llmRate.output) /
      1e6;
  }

  const pstnRate =
    usage.phoneLeg === false ? 0 : pstnRateFor(usage.toNumber, rates.cost.pstnInrPerMin);
  const costPstn = (billable / 60) * pstnRate;

  const parts = [costStt, costTts, costLlm];
  const costTotal = parts.some((p) => p === null)
    ? null
    : parts.reduce((sum, p) => sum! + p!, 0)! + costPstn;

  let price: number | null = null;
  if (rates.sell.mode === "per_minute" && rates.sell.perMinuteInr !== undefined) {
    price = (billable / 60) * rates.sell.perMinuteInr;
  } else if (
    rates.sell.mode === "cost_plus" &&
    rates.sell.markupMultiplier !== undefined &&
    costTotal !== null
  ) {
    price = costTotal * rates.sell.markupMultiplier;
  }

  return {
    billableSeconds: billable,
    costSttInr: round(costStt),
    costTtsInr: round(costTts),
    costLlmInr: round(costLlm),
    costPstnInr: round(costPstn),
    costTotalInr: round(costTotal),
    priceInr: round(price),
    rateCardId: card.id,
    // A missing cost rate flags the row; a missing *price* is worse, since it
    // means the call cannot be charged for at all.
    needsReview: missing.length > 0 || price === null,
    reviewReason:
      missing.length > 0
        ? `no rate for ${missing.join(", ")}`
        : price === null
          ? "rate card defines no sell terms"
          : null,
  };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}
