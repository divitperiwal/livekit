import { describe, expect, test } from "bun:test";
import { billableSeconds, priceCall } from "../../src/modules/billing/pricing";
import { oneMinuteOfUsage, seedLikeRates } from "../fixtures/rate-card";

const price = (overrides: Partial<Parameters<typeof priceCall>[0]> = {}) =>
  priceCall({
    rates: seedLikeRates,
    usage: oneMinuteOfUsage,
    durationSeconds: 60,
    remoteNumber: "+919876543210",
    includedSecondsLeft: 0,
    ...overrides,
  });

describe("billable seconds", () => {
  test("a call that never connected bills nothing", () => {
    expect(billableSeconds(0, seedLikeRates)).toBe(0);
  });
  test("a short call bills the minimum", () => {
    expect(billableSeconds(10, seedLikeRates)).toBe(30);
  });
  test("a longer call rounds up to the increment", () => {
    expect(billableSeconds(45, seedLikeRates)).toBe(45);
    expect(billableSeconds(61, { minimumSeconds: 0, incrementSeconds: 6 })).toBe(66);
  });
});

describe("pricing a call", () => {
  test("per-minute sell: ₹6/min for a 45 s call is ₹4.50", () => {
    expect(price({ durationSeconds: 45 }).priceInr).toBe(4.5);
  });

  test("cost is priced per component at the card's rates", () => {
    const priced = price();
    expect(priced.sttCostInr).toBe(0.5);
    expect(priced.ttsCostInr).toBe(1.8);
    expect(priced.llmCostInr).toBe(0.6149); // 20k × 29.28/M + 400 × 73.2/M
    expect(priced.pstnCostInr).toBe(0.785);
    expect(priced.totalCostInr).toBe(3.6999);
    expect(priced.reviewReasons).toEqual([]);
  });

  test("cached tokens are charged at the cached rate, within the prompt", () => {
    const priced = price({ usage: { ...oneMinuteOfUsage, llmCachedTokens: 10_000 } });
    expect(priced.llmCostInr).toBe(0.4319); // 10k × 29.28/M + 10k × 10.98/M + 400 × 73.2/M
  });

  test("the longest matching PSTN prefix wins", () => {
    expect(price({ remoteNumber: "+14155550100" }).pstnCostInr).toBe(2);
    expect(price({ remoteNumber: "+919876543210" }).pstnCostInr).toBe(0.785);
  });

  test("guarantee 11: an unpriced model costs zero and is flagged, never dropped", () => {
    const priced = price({ usage: { ...oneMinuteOfUsage, llmModel: "new-model" } });
    expect(priced.llmCostInr).toBe(0);
    expect(priced.priceInr).toBe(6);
    expect(priced.reviewReasons).toEqual(["no LLM rate for new-model"]);
  });

  test("cost-plus sells at cost plus the markup", () => {
    const priced = price({
      rates: { ...seedLikeRates, sell: { kind: "cost_plus", markupPercent: 50 } },
    });
    expect(priced.priceInr).toBe(5.55); // 3.6999 × 1.5
  });

  test("included minutes are used up before anything is charged", () => {
    expect(price({ durationSeconds: 60, includedSecondsLeft: 90 }).priceInr).toBe(0);
    expect(price({ durationSeconds: 60, includedSecondsLeft: 30 }).priceInr).toBe(3);
  });
});
