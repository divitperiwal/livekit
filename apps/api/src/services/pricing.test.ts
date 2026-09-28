/**
 * Pricing a call.
 *
 * Pure arithmetic, so these run without a database. The figures are written
 * out longhand rather than derived from the card under test -- deriving them
 * from the same numbers the code reads would pass even if those numbers were
 * wrong.
 */

import { describe, expect, test } from "bun:test";

import { billableSeconds, priceCall, pstnRateFor, type Rates } from "./pricing";

const RATES: Rates = {
  cost: {
    sttInrPerMin: { "saaras:v4": 0.5 },
    ttsInrPerChar: { "bulbul:v3": 0.003 },
    llmInrPerMtok: { "sarvam-105b-conversations": { input: 29.28, output: 73.2 } },
    llmInrCachedPerMtok: { "sarvam-105b-conversations": 10.98 },
    pstnInrPerMin: { "+91": 0.6, "+1": 2.4, default: 3.0 },
  },
  sell: {
    mode: "per_minute",
    perMinuteInr: 6.0,
    minimumSeconds: 30,
    incrementSeconds: 1,
  },
};

const CARD = { id: "card-1", rates: RATES };

const MODELS = {
  sttModel: "saaras:v4",
  ttsModel: "bulbul:v3",
  llmModel: "sarvam-105b-conversations",
};

const NOTHING = {
  sttSeconds: 0,
  ttsCharacters: 0,
  llmPromptTokens: 0,
  llmCachedTokens: 0,
  llmCompletionTokens: 0,
  durationSeconds: 0,
  ...MODELS,
};

describe("billable seconds", () => {
  test("a short call is charged the minimum", () => {
    // Thirty seconds is standard for voice, and is what makes a flurry of
    // very short calls worth carrying.
    expect(billableSeconds(4, { minimumSeconds: 30, incrementSeconds: 1 })).toBe(30);
  });

  test("a longer call is charged what it took", () => {
    expect(billableSeconds(95, { minimumSeconds: 30, incrementSeconds: 1 })).toBe(95);
  });

  test("partial increments round up", () => {
    expect(billableSeconds(61, { minimumSeconds: 30, incrementSeconds: 60 })).toBe(120);
  });

  test("a zero increment does not divide by zero", () => {
    expect(billableSeconds(45, { minimumSeconds: 0, incrementSeconds: 0 })).toBe(45);
  });
});

describe("the carrier rate", () => {
  test("is chosen by prefix", () => {
    expect(pstnRateFor("+919876543210", RATES.cost.pstnInrPerMin)).toBe(0.6);
    expect(pstnRateFor("+14155551234", RATES.cost.pstnInrPerMin)).toBe(2.4);
  });

  test("falls back for an unknown destination", () => {
    expect(pstnRateFor("+447700900123", RATES.cost.pstnInrPerMin)).toBe(3.0);
  });

  test("falls back when the number is unknown", () => {
    expect(pstnRateFor(null, RATES.cost.pstnInrPerMin)).toBe(3.0);
  });

  test("the longest matching prefix wins", () => {
    const rates = { "+9": 9, "+91": 1, "+9188": 0.1, default: 99 };
    expect(pstnRateFor("+918812345678", rates)).toBe(0.1);
  });
});

describe("pricing a call", () => {
  test("charges per minute of billable time", () => {
    // Two minutes at Rs 6/min.
    const priced = priceCall({ ...NOTHING, durationSeconds: 120 }, CARD);
    expect(priced.priceInr).toBeCloseTo(12.0, 6);
  });

  test("a four-second call is still charged the thirty-second minimum", () => {
    const priced = priceCall({ ...NOTHING, durationSeconds: 4 }, CARD);
    expect(priced.billableSeconds).toBe(30);
    expect(priced.priceInr).toBeCloseTo(3.0, 6);
  });

  test("costs each component from the card", () => {
    const priced = priceCall(
      {
        ...NOTHING,
        sttSeconds: 120, // 2 min at Rs 0.50 = Rs 1.00
        ttsCharacters: 10_000, // at Rs 0.003 = Rs 30.00
        llmPromptTokens: 1_000_000, // at Rs 29.28/Mtok
        llmCompletionTokens: 1_000_000, // at Rs 73.20/Mtok
        durationSeconds: 120,
        toNumber: "+919876543210", // 2 min at Rs 0.60 = Rs 1.20
      },
      CARD,
    );

    expect(priced.costSttInr).toBeCloseTo(1.0, 6);
    expect(priced.costTtsInr).toBeCloseTo(30.0, 6);
    expect(priced.costLlmInr).toBeCloseTo(102.48, 6);
    expect(priced.costPstnInr).toBeCloseTo(1.2, 6);
    expect(priced.costTotalInr).toBeCloseTo(134.68, 6);
  });

  test("a call with no phone line pays no carrier", () => {
    // A browser test call: no number at either end. The fallback rate is for
    // a real call whose number is unknown, not for a call with no line at all.
    const priced = priceCall(
      { ...NOTHING, ttsCharacters: 1_000, durationSeconds: 120, toNumber: null, phoneLeg: false },
      CARD,
    );
    expect(priced.costPstnInr).toBe(0);
    expect(priced.costTotalInr).toBeCloseTo(3.0, 6);
  });

  test("an unknown number on a real call is still charged the fallback", () => {
    const priced = priceCall({ ...NOTHING, durationSeconds: 60, toNumber: null }, CARD);
    expect(priced.costPstnInr).toBeCloseTo(3.0, 6);
  });

  test("cached tokens are a subset of the prompt, not an addition", () => {
    // Providers report cached tokens within the prompt total. Charging both at
    // the fresh rate would overbill every long call.
    const priced = priceCall(
      {
        ...NOTHING,
        llmPromptTokens: 1_000_000,
        llmCachedTokens: 1_000_000,
        durationSeconds: 60,
      },
      CARD,
    );
    // Wholly cached: Rs 10.98, not Rs 29.28, and certainly not both.
    expect(priced.costLlmInr).toBeCloseTo(10.98, 6);
  });

  test("a partly cached prompt splits across both rates", () => {
    const priced = priceCall(
      {
        ...NOTHING,
        llmPromptTokens: 1_000_000,
        llmCachedTokens: 250_000,
        durationSeconds: 60,
      },
      CARD,
    );
    expect(priced.costLlmInr).toBeCloseTo(0.75 * 29.28 + 0.25 * 10.98, 6);
  });

  test("cost and price are separate numbers", () => {
    // Margin per call is wanted from the first week and cannot be
    // reconstructed later from one blended figure.
    const priced = priceCall(
      { ...NOTHING, sttSeconds: 60, durationSeconds: 60 },
      CARD,
    );
    expect(priced.costTotalInr).not.toBe(priced.priceInr);
    expect(priced.priceInr).toBeGreaterThan(priced.costTotalInr!);
  });
});

describe("pricing degrades rather than failing", () => {
  test("an unpriced model flags the row instead of losing it", () => {
    // Losing a usage record is revenue that silently never existed; a flagged
    // row can be repriced once the card catches up.
    const priced = priceCall(
      { ...NOTHING, sttModel: "saaras:v99", durationSeconds: 60 },
      CARD,
    );
    expect(priced.needsReview).toBe(true);
    expect(priced.reviewReason).toContain("saaras:v99");
    expect(priced.costSttInr).toBeNull();
    expect(priced.costTotalInr).toBeNull();
    // Still charged: the customer had a call, whatever our rate table says.
    expect(priced.priceInr).toBeCloseTo(6.0, 6);
  });

  test("no rate card flags the row and prices nothing", () => {
    const priced = priceCall({ ...NOTHING, durationSeconds: 60 }, null);
    expect(priced.needsReview).toBe(true);
    expect(priced.reviewReason).toContain("no rate card");
    expect(priced.priceInr).toBeNull();
  });

  test("a card with no sell terms is flagged", () => {
    const priced = priceCall(
      { ...NOTHING, durationSeconds: 60 },
      { id: "c", rates: { ...RATES, sell: { ...RATES.sell, perMinuteInr: undefined } } },
    );
    expect(priced.priceInr).toBeNull();
    expect(priced.reviewReason).toContain("sell terms");
  });

  test("cost-plus pricing applies the markup", () => {
    const priced = priceCall(
      { ...NOTHING, sttSeconds: 120, durationSeconds: 120, toNumber: "+91999" },
      {
        id: "c",
        rates: {
          ...RATES,
          sell: { ...RATES.sell, mode: "cost_plus", markupMultiplier: 2 },
        },
      },
    );
    expect(priced.priceInr).toBeCloseTo(priced.costTotalInr! * 2, 6);
  });
});
