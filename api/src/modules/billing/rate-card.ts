import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseTransaction } from "../../db/database";
import { rateCards } from "../../db/schema";

const inrRate = z.number().nonnegative();

/**
 * `rate_cards.rates`. Cost rates are in the units Sarvam lists them in; PSTN is per
 * minute by number prefix (longest match wins) and covers every telephony leg
 * (Plivo + LiveKit SIP).
 */
export const rateCardRatesSchema = z.strictObject({
  cost: z.strictObject({
    sttInrPerMinute: z.record(z.string(), inrRate),
    ttsInrPer10kCharacters: z.record(z.string(), inrRate),
    llmInrPerMillionTokens: z.record(
      z.string(),
      z.strictObject({ input: inrRate, cachedInput: inrRate, output: inrRate }),
    ),
    pstnInrPerMinute: z.array(
      z.strictObject({ prefix: z.string().regex(/^\+\d*$/), inrPerMinute: inrRate }),
    ),
  }),
  sell: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("per_minute"), inrPerMinute: inrRate }),
    z.strictObject({ kind: z.literal("cost_plus"), markupPercent: z.number().min(0) }),
  ]),
  minimumSeconds: z.number().int().min(0),
  incrementSeconds: z.number().int().min(1),
  /** Free minutes per calendar month (IST), per account. */
  includedMinutes: z.number().int().min(0).default(0),
});

export type RateCardRates = z.output<typeof rateCardRatesSchema>;
export type RateCard = { id: string; rates: RateCardRates };

/** The account's own card in effect at `at`, else the global one; null when neither exists. */
export async function findRateCard(
  db: Database | DatabaseTransaction,
  accountId: string,
  at: Date,
): Promise<RateCard | null> {
  const inEffect = and(
    lte(rateCards.effectiveFrom, at),
    or(isNull(rateCards.effectiveTo), gt(rateCards.effectiveTo, at)),
  );
  for (const owner of [eq(rateCards.accountId, accountId), isNull(rateCards.accountId)]) {
    const [card] = await db
      .select({ id: rateCards.id, rates: rateCards.rates })
      .from(rateCards)
      .where(and(owner, inEffect))
      .orderBy(desc(rateCards.effectiveFrom))
      .limit(1);
    if (card) return { id: card.id, rates: rateCardRatesSchema.parse(card.rates) };
  }
  return null;
}
