import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accountLedger,
  callEvents,
  calls,
  suppressedNumbers,
  usageRecords,
  webhookDeliveries,
} from "../../src/db/schema";
import { CALLER_NUMBER, CLINIC_NUMBER, createScenario, event } from "../http/scenario";

describe("POST /internal/calls (open)", () => {
  test("opens an answered inbound call on the org's number", async () => {
    const { open, db, ids } = await createScenario();
    const { status, body } = await open();
    expect(status).toBe(201);
    expect(body.orgId).toBe(ids.orgId);
    const [call] = await db.select().from(calls).where(eq(calls.id, body.id));
    expect(call).toMatchObject({
      status: "in_progress",
      answered: true,
      phoneNumberId: ids.phoneNumberId,
      fromNumber: CALLER_NUMBER,
      toNumber: CLINIC_NUMBER,
    });
  });

  test("an outbound call not yet answered opens as ringing", async () => {
    const { open, db } = await createScenario();
    const { body } = await open({
      direction: "outbound",
      answered: false,
      fromNumber: CLINIC_NUMBER,
      toNumber: CALLER_NUMBER,
    });
    const [call] = await db.select().from(calls).where(eq(calls.id, body.id));
    expect(call?.status).toBe("ringing");
  });

  test("attaches the job to a call the API queued, so the client's call id holds", async () => {
    const { open, db, ids } = await createScenario();
    const callId = crypto.randomUUID();
    await db.insert(calls).values({
      id: callId,
      requestId: callId,
      orgId: ids.orgId,
      agentId: ids.agentId,
      agentVersionId: ids.agentVersionId,
      direction: "outbound",
      status: "queued",
      toNumber: CALLER_NUMBER,
    });
    const { body } = await open({
      requestId: callId,
      direction: "outbound",
      fromNumber: CLINIC_NUMBER,
      toNumber: CALLER_NUMBER,
    });
    expect(body.id).toBe(callId);
    expect(await db.$count(calls)).toBe(1);
  });
});

describe("POST /internal/calls/:id/events", () => {
  test("writes events in order and rejects an unknown call", async () => {
    const { open, appendEvents, db } = await createScenario();
    const { body } = await open();
    expect(
      (
        await appendEvents(body.id, [
          event(1),
          event(2, { role: "assistant", type: "agent_message" }),
        ])
      ).body,
    ).toEqual({ inserted: 2 });
    expect(await db.$count(callEvents, eq(callEvents.callId, body.id))).toBe(2);
    expect((await appendEvents(crypto.randomUUID(), [event(1)])).status).toBe(404);
  });
});

describe("POST /internal/calls/:id/finalize", () => {
  test("closes the call with its analysis and prices its usage", async () => {
    const { open, finalize, db, ids } = await createScenario();
    const { body } = await open();
    const result = await finalize(body.id, {
      recordingKey: "recordings/clinic-42/call-room-1.ogg",
      analysis: {
        summary: "Booked for Monday.",
        disposition: "booked",
        fields: { day: "Monday" },
        qa: [],
      },
    });
    expect(result).toEqual({ status: 200, body: { id: body.id, status: "completed" } });

    const [call] = await db.select().from(calls).where(eq(calls.id, body.id));
    expect(call).toMatchObject({
      status: "completed",
      durationSeconds: 60,
      disposition: "booked",
      summary: "Booked for Monday.",
    });
    expect(call?.finalizedAt).not.toBeNull();

    const [usage] = await db.select().from(usageRecords).where(eq(usageRecords.callId, body.id));
    expect(usage).toMatchObject({
      billableSeconds: 60,
      priceInr: "6.00",
      totalCostInr: "3.6999",
      needsReview: false,
    });
    const [entry] = await db
      .select()
      .from(accountLedger)
      .where(eq(accountLedger.usageRecordId, usage!.id));
    expect(entry).toMatchObject({ accountId: ids.accountId, kind: "usage", amountInr: "6.00" });
  });

  test("queues call.ended with the transcript, and usage.recorded for the account to debit", async () => {
    const { open, appendEvents, finalize, db } = await createScenario();
    const { body } = await open();
    await appendEvents(body.id, [
      event(1, { content: "Appointment chahiye" }),
      event(2, { type: "stage_change", role: null }),
    ]);
    await finalize(body.id);

    const deliveries = await db.select().from(webhookDeliveries);
    const ended = deliveries.find((delivery) => delivery.event === "call.ended")!;
    const recorded = deliveries.find((delivery) => delivery.event === "usage.recorded")!;
    expect((ended.payload as any).call).toMatchObject({
      id: body.id,
      orgId: "clinic-42",
      finalized: true,
      usage: { priceInr: 6 },
    });
    expect((ended.payload as any).transcript).toEqual([
      { seq: 1, role: "user", content: "Appointment chahiye", at: "2026-10-05T10:00:01.000Z" },
    ]);
    const [usage] = await db.select().from(usageRecords);
    expect(recorded.payload).toEqual({
      orgId: "clinic-42",
      callId: body.id,
      usageRecordId: usage!.id,
      priceInr: 6,
    });
  });

  test("an unanswered call writes no usage and charges nothing", async () => {
    const { open, finalize, db } = await createScenario();
    const { body } = await open({
      direction: "outbound",
      answered: false,
      fromNumber: CLINIC_NUMBER,
      toNumber: CALLER_NUMBER,
    });
    await finalize(body.id, { status: "no_answer", durationSeconds: 0, usage: null });
    expect(await db.$count(usageRecords)).toBe(0);
    expect(await db.$count(accountLedger)).toBe(0);
  });

  test("a caller who asks not to be called again goes on the org's do-not-call list", async () => {
    const { open, finalize, db, ids } = await createScenario();
    const { body } = await open();
    await finalize(body.id, { doNotCall: true });
    const [entry] = await db.select().from(suppressedNumbers);
    expect(entry).toMatchObject({
      orgId: ids.orgId,
      e164: CALLER_NUMBER,
      source: "caller_request",
      callId: body.id,
    });
  });

  test("with no rate card, usage is still written, flagged for review", async () => {
    const { open, finalize, db } = await createScenario({ rateCard: false });
    const { body } = await open();
    await finalize(body.id);
    const [usage] = await db.select().from(usageRecords);
    expect(usage).toMatchObject({
      needsReview: true,
      reviewReason: "no rate card in effect",
      priceInr: "0.00",
    });
  });

  test("crossing 80% of the credit cap warns the account once", async () => {
    const { open, finalize, db } = await createScenario({ account: { creditCapInr: "10.00" } });
    const first = await open();
    await finalize(first.body.id); // ₹6: 60%
    expect(
      await db.$count(webhookDeliveries, eq(webhookDeliveries.event, "account.credit_low")),
    ).toBe(0);
    const second = await open();
    await finalize(second.body.id, { durationSeconds: 30 }); // ₹3 more: 90%
    const warnings = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event, "account.credit_low"));
    expect(warnings.map((warning) => warning.payload)).toEqual([
      { unpaidInr: 9, creditCapInr: 10 },
    ]);
  });
});
