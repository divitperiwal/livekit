import { describe, expect, test } from "bun:test";
import { calls, callEvents } from "../../src/db/schema";
import { createScenario, event } from "../http/scenario";

const said = "Mera number 98765 43210 hai, email ravi@example.com";

async function callWithPersonalData(redactPii: boolean) {
  const { open, appendEvents, finalize, db } = await createScenario({ org: { redactPii } });
  const { body } = await open();
  await appendEvents(body.id, [
    event(1, { content: said, payload: { transcriptAlternatives: [said] } }),
  ]);
  await finalize(body.id, {
    analysis: {
      summary: `Caller gave ${said}`,
      disposition: null,
      fields: { callbackNumber: "9876543210" },
      qa: [],
    },
  });
  const [stored] = await db.select().from(callEvents);
  const [call] = await db.select().from(calls);
  return { stored: stored!, call: call! };
}

describe("guarantee 19: with redaction on, unmasked PII is never written", () => {
  test("transcript text, event payloads, the summary and analysis fields are masked", async () => {
    const { stored, call } = await callWithPersonalData(true);
    const masked = "Mera number [number] hai, email [email]";
    expect(stored.content).toBe(masked);
    expect(stored.payload).toEqual({ transcriptAlternatives: [masked] });
    expect(call.summary).toBe(`Caller gave ${masked}`);
    expect(call.analysisFields).toEqual({ callbackNumber: "[number]" });
  });

  test("with redaction off, text is kept as said", async () => {
    const { stored, call } = await callWithPersonalData(false);
    expect(stored.content).toBe(said);
    expect(call.analysisFields).toEqual({ callbackNumber: "9876543210" });
  });
});
