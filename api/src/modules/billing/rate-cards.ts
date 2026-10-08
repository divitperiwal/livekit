import { and, desc, eq, isNull } from "drizzle-orm";
import { onlyRow, type Database } from "../../db/database";
import { rateCards } from "../../db/schema";
import { rateCardRatesSchema, type RateCardRates } from "./rate-card";

/**
 * The spec's seed card: sells at ₹6/min, 30 s minimum, 1 s increments. Costs are Sarvam
 * list prices (as in the worker's `cost/prices.py`) and, for Indian numbers, Plivo ₹0.40 +
 * LiveKit SIP ≈ ₹0.385 per minute. Other countries have no PSTN rate, so their calls are
 * flagged for review rather than priced by guess.
 */
export const SEED_RATE_CARD: RateCardRates = {
  cost: {
    sttInrPerMinute: { "saaras:v4": 0.5, "saaras:v3": 0.5 },
    ttsInrPer10kCharacters: { "bulbul:v3": 30, "bulbul:v3-beta": 30, "bulbul:v2": 30 },
    llmInrPerMillionTokens: Object.fromEntries(
      ["sarvam-105b", "sarvam-105b-conversations", "gemma4", "glm5.2"].map((model) => [
        model,
        { input: 29.28, cachedInput: 10.98, output: 73.2 },
      ]),
    ),
    pstnInrPerMinute: [{ prefix: "+91", inrPerMinute: 0.785 }],
  },
  sell: { kind: "per_minute", inrPerMinute: 6 },
  minimumSeconds: 30,
  incrementSeconds: 1,
  includedMinutes: 0,
};

/**
 * Puts a card in effect from `effectiveFrom` for one account (or globally), closing the
 * owner's open card at that moment, so exactly one card is in effect at any time.
 */
export async function addRateCard(
  db: Database,
  input: { accountId: string | null; name: string; rates: unknown; effectiveFrom: Date },
) {
  const rates = rateCardRatesSchema.parse(input.rates);
  const owner =
    input.accountId === null
      ? isNull(rateCards.accountId)
      : eq(rateCards.accountId, input.accountId);
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(rateCards)
      .where(and(owner, isNull(rateCards.effectiveTo)))
      .orderBy(desc(rateCards.effectiveFrom))
      .for("update");
    if (open) {
      if (open.effectiveFrom >= input.effectiveFrom) {
        throw new Error(
          `the current card "${open.name}" starts ${open.effectiveFrom.toISOString()}; a new card must start after it`,
        );
      }
      await tx
        .update(rateCards)
        .set({ effectiveTo: input.effectiveFrom })
        .where(eq(rateCards.id, open.id));
    }
    return tx
      .insert(rateCards)
      .values({
        accountId: input.accountId,
        name: input.name,
        rates,
        effectiveFrom: input.effectiveFrom,
      })
      .returning()
      .then(onlyRow);
  });
}

export function listRateCards(db: Database, accountId: string | null) {
  const owner =
    accountId === null ? isNull(rateCards.accountId) : eq(rateCards.accountId, accountId);
  return db
    .select({
      name: rateCards.name,
      effectiveFrom: rateCards.effectiveFrom,
      effectiveTo: rateCards.effectiveTo,
      rates: rateCards.rates,
    })
    .from(rateCards)
    .where(owner)
    .orderBy(desc(rateCards.effectiveFrom));
}
