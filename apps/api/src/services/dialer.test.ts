/**
 * The dialer, against a real database.
 *
 * What these guard is who gets called: never more calls in flight than the
 * campaign allows, never someone on the do-not-call list, never an attempt
 * lost because a worker died, and never a contact retried off a previous
 * attempt's call record.
 *
 * The dispatcher is a fake that records what it was asked to do. Everything
 * between it and the database is the production path.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import {
  agents,
  agentVersions,
  campaignContacts,
  campaigns,
  orgBalances,
  orgs,
  phoneNumbers,
  suppressedNumbers,
} from "../db/schema";
import { finalizeCall, startCall } from "./calls";
import { claimContacts, dialTick, NEVER_CONNECTED_AFTER_MS, type Dispatcher } from "./dialer";

const { sql, db } = createClient({ max: 4 });
const created: string[] = [];

// Monday 11:00 in India: inside the default window and the Indian outer bound.
const OPEN = new Date("2026-09-28T05:30:00Z");
// Monday 22:00 in India: outside both.
const NIGHT = new Date("2026-09-28T16:30:00Z");

class FakeDispatcher implements Dispatcher {
  calls: Array<{ roomName: string; metadata: Record<string, unknown> }> = [];
  fail = false;
  async dispatch(roomName: string, metadata: Record<string, unknown>) {
    if (this.fail) throw new Error("no workers");
    this.calls.push({ roomName, metadata });
  }
}

let orgId = "";
let agentId = "";
let versionId = "";
let campaignId = "";
let fromE164 = "";

function randomNumber(prefix = "+9170") {
  return `${prefix}${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
}

beforeEach(async () => {
  // A tick works every running campaign in the database, so the ones earlier
  // tests left running would otherwise be dialled here too.
  if (created.length > 0) {
    await db.update(campaigns).set({ status: "cancelled" }).where(inArray(campaigns.orgId, created));
  }

  const suffix = Math.random().toString(36).slice(2, 10);
  const org = (await db.insert(orgs).values({ name: "Dialer", slug: `dialer-${suffix}` }).returning())[0]!;
  await db.insert(orgBalances).values({ orgId: org.id, balanceInr: "1000" });
  const agent = (await db.insert(agents).values({ orgId: org.id, name: "A", slug: `a-${suffix}` }).returning())[0]!;
  const version = (
    await db
      .insert(agentVersions)
      .values({ agentId: agent.id, orgId: org.id, version: 1, instructions: "p", greeting: "g", config: {}, publishedAt: new Date() })
      .returning()
  )[0]!;
  await db.update(agents).set({ liveVersionId: version.id }).where(eq(agents.id, agent.id));

  fromE164 = randomNumber("+9180");
  const number = (
    await db.insert(phoneNumbers).values({ orgId: org.id, e164: fromE164, status: "assigned", direction: "both" }).returning()
  )[0]!;

  const campaign = (
    await db
      .insert(campaigns)
      .values({
        orgId: org.id,
        agentId: agent.id,
        name: "Renewals",
        status: "running",
        fromNumberId: number.id,
        concurrency: 2,
        schedule: { timezone: "Asia/Kolkata", windows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "09:00", end: "21:00" }] },
        retryPolicy: { maxAttempts: 2, retryAfterMinutes: [30], retryOn: ["no_answer", "busy", "failed", "voicemail"] },
      })
      .returning()
  )[0]!;

  orgId = org.id;
  agentId = agent.id;
  versionId = version.id;
  campaignId = campaign.id;
  created.push(org.id);
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(orgs).where(eq(orgs.id, id)).catch((error) => console.error(error));
  }
  await Promise.allSettled([sql.end(), closeRedis()]);
});

async function addContacts(n: number, prefix = "+9170") {
  const rows = Array.from({ length: n }, (_, i) => ({
    campaignId,
    orgId,
    e164: randomNumber(prefix),
    variables: { name: `Contact ${i}` },
  }));
  return db.insert(campaignContacts).values(rows).returning();
}

async function contact(id: string) {
  return (await db.select().from(campaignContacts).where(eq(campaignContacts.id, id)))[0]!;
}

async function campaign() {
  return (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]!;
}

/** What the worker does for a dispatched contact: open, then finalise, a call. */
async function workerCall(contactId: string, status: "completed" | "no_answer" | "busy" | "failed" | "voicemail", endReason?: string) {
  const call = await startCall(db, {
    orgId,
    agentId,
    agentVersionId: versionId,
    lkRoomName: "camp-room",
    lkJobId: `JOB_${crypto.randomUUID()}`,
    direction: "outbound",
    toNumber: (await contact(contactId)).e164,
    answered: status === "completed" || status === "voicemail",
    campaignId,
    contactId,
  });
  await finalizeCall(db, call.id, { status, endReason: endReason ?? null, durationSeconds: 0 });
  return call;
}

describe("dialling", () => {
  test("dispatches no more than the campaign's concurrency", async () => {
    await addContacts(5);
    const dispatcher = new FakeDispatcher();
    await dialTick(db, dispatcher, OPEN);
    expect(dispatcher.calls).toHaveLength(2);

    // Nothing has finished, so a second tick has no free slot.
    await dialTick(db, dispatcher, OPEN);
    expect(dispatcher.calls).toHaveLength(2);
  });

  test("two dialers at once still respect the concurrency", async () => {
    await addContacts(10);
    const c = await campaign();
    const [a, b] = await Promise.all([claimContacts(db, c, OPEN, true), claimContacts(db, c, OPEN, true)]);
    expect(a.length + b.length).toBe(2);
  });

  test("the job carries everything the worker needs to place the call", async () => {
    const [row] = await addContacts(1);
    const dispatcher = new FakeDispatcher();
    await dialTick(db, dispatcher, OPEN);

    expect(dispatcher.calls[0]!.metadata).toMatchObject({
      orgId,
      agentId,
      direction: "outbound",
      placeCall: true,
      toNumber: row!.e164,
      fromNumber: fromE164,
      campaignId,
      contactId: row!.id,
      variables: { name: "Contact 0" },
    });
    const claimed = await contact(row!.id);
    expect(claimed.status).toBe("dialing");
    expect(claimed.attempts).toBe(1);
  });

  test("nobody is called outside the campaign's window", async () => {
    await addContacts(2);
    const dispatcher = new FakeDispatcher();
    await dialTick(db, dispatcher, NIGHT);
    expect(dispatcher.calls).toHaveLength(0);
  });

  test("Indian numbers are held back outside the national window even if the schedule is open", async () => {
    await db
      .update(campaigns)
      .set({ schedule: { timezone: "America/New_York", windows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "09:00", end: "17:00" }] } })
      .where(eq(campaigns.id, campaignId));
    await addContacts(1, "+9170");
    const [foreign] = await addContacts(1, "+1415");

    // 16:30Z is 12:30 in New York and 22:00 in India.
    const dispatcher = new FakeDispatcher();
    await dialTick(db, dispatcher, NIGHT);
    expect(dispatcher.calls.map((c) => c.metadata.contactId)).toEqual([foreign!.id]);
  });

  test("a suppressed number is never dialled, however it got on the list", async () => {
    const [row] = await addContacts(1);
    // Added to the do-not-call list after the contact was uploaded.
    await db.insert(suppressedNumbers).values({ orgId, e164: row!.e164, source: "manual" });

    const dispatcher = new FakeDispatcher();
    await dialTick(db, dispatcher, OPEN);
    expect(dispatcher.calls).toHaveLength(0);
    expect((await contact(row!.id)).status).toBe("suppressed");
  });

  test("a campaign that cannot pay is paused with a reason, not dialled", async () => {
    await addContacts(1);
    await db.update(orgBalances).set({ balanceInr: "0", creditLimitInr: "0" }).where(eq(orgBalances.orgId, orgId));
    const dispatcher = new FakeDispatcher();
    await dialTick(db, dispatcher, OPEN);

    expect(dispatcher.calls).toHaveLength(0);
    const c = await campaign();
    expect(c.status).toBe("paused");
    expect(c.statusReason).toBe("out of credit");
  });

  test("a refused dispatch gives the attempt back", async () => {
    const [row] = await addContacts(1);
    const dispatcher = new FakeDispatcher();
    dispatcher.fail = true;
    await dialTick(db, dispatcher, OPEN);

    const after = await contact(row!.id);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);
    expect(after.lastOutcome).toBe("dispatch_failed");
  });
});

describe("after the call", () => {
  test("a conversation completes the contact, and then the campaign", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);
    await workerCall(row!.id, "completed");

    const report = await dialTick(db, new FakeDispatcher(), OPEN);
    expect(report.reconciled).toBe(1);
    expect((await contact(row!.id)).status).toBe("completed");
    expect((await campaign()).status).toBe("completed");
  });

  test("an unanswered call is retried later, then given up on", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);
    await workerCall(row!.id, "no_answer", "sip_480");
    await dialTick(db, new FakeDispatcher(), OPEN);

    const waiting = await contact(row!.id);
    expect(waiting.status).toBe("pending");
    expect(waiting.lastOutcome).toBe("no_answer");
    expect(waiting.nextAttemptAt?.toISOString()).toBe(new Date(OPEN.getTime() + 30 * 60_000).toISOString());

    // Not due yet: nothing dispatched.
    const early = new FakeDispatcher();
    await dialTick(db, early, new Date(OPEN.getTime() + 10 * 60_000));
    expect(early.calls).toHaveLength(0);

    // Due: the second and last attempt.
    const later = new Date(OPEN.getTime() + 31 * 60_000);
    const second = new FakeDispatcher();
    await dialTick(db, second, later);
    expect(second.calls).toHaveLength(1);
    await workerCall(row!.id, "busy", "sip_486");
    await dialTick(db, new FakeDispatcher(), later);

    const final = await contact(row!.id);
    expect(final.status).toBe("exhausted");
    expect(final.attempts).toBe(2);
  });

  test("a number that does not exist is not retried", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);
    await workerCall(row!.id, "failed", "sip_404");
    await dialTick(db, new FakeDispatcher(), OPEN);
    expect((await contact(row!.id)).status).toBe("failed");
  });

  test("an attempt that never became a call is counted, after a grace period", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);

    // Still within the grace period: left alone.
    await dialTick(db, new FakeDispatcher(), new Date(OPEN.getTime() + 60_000));
    expect((await contact(row!.id)).status).toBe("dialing");

    await dialTick(db, new FakeDispatcher(), new Date(OPEN.getTime() + NEVER_CONNECTED_AFTER_MS + 1000));
    const after = await contact(row!.id);
    expect(after.status).toBe("pending");
    expect(after.lastOutcome).toBe("never_connected");
  });

  test("a retry is not moved on by the previous attempt's finished call", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);
    await workerCall(row!.id, "no_answer");
    await dialTick(db, new FakeDispatcher(), OPEN);

    // The retry is dispatched; its call has not been opened yet.
    const later = new Date(OPEN.getTime() + 31 * 60_000);
    await dialTick(db, new FakeDispatcher(), later);
    await dialTick(db, new FakeDispatcher(), later);
    expect((await contact(row!.id)).status).toBe("dialing");
  });

  test("a caller who asks not to be called again is added to the list", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);
    const call = await startCall(db, {
      orgId,
      agentId,
      agentVersionId: versionId,
      lkRoomName: "r",
      lkJobId: `JOB_${crypto.randomUUID()}`,
      direction: "outbound",
      toNumber: row!.e164,
      contactId: row!.id,
    });
    await finalizeCall(db, call.id, { status: "completed", doNotCall: true });

    const listed = await db
      .select()
      .from(suppressedNumbers)
      .where(and(eq(suppressedNumbers.orgId, orgId), eq(suppressedNumbers.e164, row!.e164)));
    expect(listed[0]?.source).toBe("call");
    expect(listed[0]?.callId).toBe(call.id);
  });

  test("a contact id from another organisation links nothing", async () => {
    const [row] = await addContacts(1);
    await dialTick(db, new FakeDispatcher(), OPEN);

    const otherOrg = (await db.insert(orgs).values({ name: "Other", slug: `other-${crypto.randomUUID().slice(0, 8)}` }).returning())[0]!;
    created.push(otherOrg.id);
    const otherAgent = (await db.insert(agents).values({ orgId: otherOrg.id, name: "O", slug: "o" }).returning())[0]!;
    await startCall(db, {
      orgId: otherOrg.id,
      agentId: otherAgent.id,
      agentVersionId: versionId,
      lkRoomName: "r",
      lkJobId: `JOB_${crypto.randomUUID()}`,
      direction: "outbound",
      contactId: row!.id,
    });
    expect((await contact(row!.id)).lastCallId).toBeNull();
  });
});
