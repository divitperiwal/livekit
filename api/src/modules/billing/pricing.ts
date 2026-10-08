import type { UsageReport } from "../../contracts/internal";
import type { RateCardRates } from "./rate-card";

export type PricedCall = {
  billableSeconds: number;
  sttCostInr: number;
  ttsCostInr: number;
  llmCostInr: number;
  pstnCostInr: number;
  totalCostInr: number;
  priceInr: number;
  /** Every reason the row needs a person to look at it; empty when fully priced. */
  reviewReasons: string[];
};

const roundTo = (places: number) => (value: number) =>
  Math.round(value * 10 ** places) / 10 ** places;
export const roundCostInr = roundTo(4);
export const roundPriceInr = roundTo(2);

/** Zero for a call that never connected; else rounded up to the increment, never under the minimum. */
export function billableSeconds(
  durationSeconds: number,
  rates: Pick<RateCardRates, "minimumSeconds" | "incrementSeconds">,
) {
  if (durationSeconds <= 0) return 0;
  const rounded = Math.ceil(durationSeconds / rates.incrementSeconds) * rates.incrementSeconds;
  return Math.max(rates.minimumSeconds, rounded);
}

function pstnRate(rates: RateCardRates, remoteNumber: string | null) {
  if (!remoteNumber) return undefined;
  const matches = rates.cost.pstnInrPerMinute.filter((entry) =>
    remoteNumber.startsWith(entry.prefix),
  );
  return matches.sort((a, b) => b.prefix.length - a.prefix.length)[0]?.inrPerMinute;
}

/**
 * Prices one call. Never throws for a missing rate: an unpriced component costs zero and
 * is listed in `reviewReasons`, so the usage row is still written (guarantee 11).
 * `includedSecondsLeft` is what remains of the month's included minutes before this call.
 */
export function priceCall(input: {
  rates: RateCardRates;
  usage: UsageReport;
  durationSeconds: number;
  remoteNumber: string | null;
  includedSecondsLeft: number;
}): PricedCall {
  const { rates, usage } = input;
  const reviewReasons: string[] = [];
  const billable = billableSeconds(input.durationSeconds, rates);

  const sttRate = rates.cost.sttInrPerMinute[usage.sttModel];
  if (sttRate === undefined) reviewReasons.push(`no STT rate for ${usage.sttModel}`);
  const sttCostInr = ((sttRate ?? 0) * usage.sttSeconds) / 60;

  const ttsRate = rates.cost.ttsInrPer10kCharacters[usage.ttsModel];
  if (ttsRate === undefined) reviewReasons.push(`no TTS rate for ${usage.ttsModel}`);
  const ttsCostInr = ((ttsRate ?? 0) * usage.ttsCharacters) / 10_000;

  const llmRate = rates.cost.llmInrPerMillionTokens[usage.llmModel];
  if (llmRate === undefined) reviewReasons.push(`no LLM rate for ${usage.llmModel}`);
  // Cached tokens are a subset of prompt tokens, not an addition to them.
  const cachedTokens = Math.min(usage.llmCachedTokens, usage.llmPromptTokens);
  const freshTokens = usage.llmPromptTokens - cachedTokens;
  const llmCostInr = llmRate
    ? (llmRate.input * freshTokens +
        llmRate.cachedInput * cachedTokens +
        llmRate.output * usage.llmCompletionTokens) /
      1e6
    : 0;

  const pstnPerMinute = pstnRate(rates, input.remoteNumber);
  if (pstnPerMinute === undefined) {
    reviewReasons.push(`no PSTN rate for ${input.remoteNumber ?? "an unknown number"}`);
  }
  const pstnCostInr = ((pstnPerMinute ?? 0) * billable) / 60;

  const totalCostInr = sttCostInr + ttsCostInr + llmCostInr + pstnCostInr;
  const chargedSeconds = Math.max(0, billable - Math.max(0, input.includedSecondsLeft));
  const priceInr =
    rates.sell.kind === "per_minute"
      ? (rates.sell.inrPerMinute * chargedSeconds) / 60
      : billable === 0
        ? 0
        : totalCostInr * (1 + rates.sell.markupPercent / 100) * (chargedSeconds / billable);

  return {
    billableSeconds: billable,
    sttCostInr: roundCostInr(sttCostInr),
    ttsCostInr: roundCostInr(ttsCostInr),
    llmCostInr: roundCostInr(llmCostInr),
    pstnCostInr: roundCostInr(pstnCostInr),
    totalCostInr: roundCostInr(totalCostInr),
    priceInr: roundPriceInr(priceInr),
    reviewReasons,
  };
}
