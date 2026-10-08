import type { RateCardRates } from "../../src/modules/billing/rate-card";
import type { UsageReport } from "../../src/contracts/internal";

/** The seed card's sell rules over Sarvam list prices; PSTN = Plivo + LiveKit SIP. */
export const seedLikeRates: RateCardRates = {
  cost: {
    sttInrPerMinute: { "saaras:v3": 0.5 },
    ttsInrPer10kCharacters: { "bulbul:v3": 30 },
    llmInrPerMillionTokens: { "sarvam-105b": { input: 29.28, cachedInput: 10.98, output: 73.2 } },
    pstnInrPerMinute: [
      { prefix: "+", inrPerMinute: 2 },
      { prefix: "+91", inrPerMinute: 0.785 },
    ],
  },
  sell: { kind: "per_minute", inrPerMinute: 6 },
  minimumSeconds: 30,
  incrementSeconds: 1,
  includedMinutes: 0,
};

export const oneMinuteOfUsage: UsageReport = {
  sttSeconds: 60,
  ttsCharacters: 600,
  llmPromptTokens: 20_000,
  llmCachedTokens: 0,
  llmCompletionTokens: 400,
  sttModel: "saaras:v3",
  ttsModel: "bulbul:v3",
  llmModel: "sarvam-105b",
};
