/**
 * The outbound dialer.
 *
 * One tick does three things, in this order:
 *
 * 1. **Reconcile.** Every contact still marked `dialing` whose call has ended
 *    is moved on -- completed, scheduled for a retry, or given up on -- from
 *    what its call record says happened. An attempt that never produced a
 *    call record at all (no worker picked it up, the worker died before it
 *    dialled) is counted as a failed attempt after a grace period, rather
 *    than holding a concurrency slot forever.
 * 2. **Dial.** For each running campaign whose calling window is open, claim
 *    as many due contacts as it has free slots, and dispatch the agent to
 *    call each one. The worker places the call itself; see the worker's
 *    `agent.py`.
 * 3. **Complete** campaigns with nobody left to call.
 *
 * Claiming happens under a per-campaign advisory lock, inside the same
 * transaction that counts calls in flight. Two dialers running at once --
 * a deploy overlapping the old process, or a second replica -- therefore
 * cannot both see a free slot and both fill it.
 *
 * The worker never writes to a contact. It writes the call record, and this
 * file reads it back, so there is exactly one place that decides whether a
 * person's phone rings again.
 */

import { and, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { AgentDispatchClient } from "livekit-server-sdk";

import type { Database } from "../db/client";
import { agents, calls, campaignContacts, campaigns, phoneNumbers } from "../db/schema";
import {
  afterAttempt,
  indiaWindowOpen,
  validateRetryPolicy,
  validateSchedule,
  windowOpen,
  type RetryPolicy,
} from "./campaign-rules";
import { standing } from "./ledger";
import { enqueue } from "./webhooks";

/**
 * How long a dispatched attempt may go without producing a call record.
 *
 * The worker opens the record once the far end answers or the dial fails, so
 * this has to outlast ringing -- a minute or so -- plus the worker picking up
 * the job. Five minutes is generous for both, and short enough that a lost
 * dispatch does not hold a slot for long.
 */
export const NEVER_CONNECTED_AFTER_MS = 5 * 60_000;

/** How long to wait before retrying a contact whose dispatch was refused. */
const DISPATCH_RETRY_MS = 60_000;

/** Puts the agent into a room with instructions to call someone. */
export interface Dispatcher {
  dispatch(roomName: string, metadata: Record<string, unknown>): Promise<void>;
}

/** The real dispatcher: LiveKit's agent dispatch API. */
export function liveKitDispatcher(): Dispatcher {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    throw new Error("dispatching agents needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET");
  }
  // The name the whole worker fleet registers under -- a routing label for
  // the pool, not a tenant identity. The tenant travels in the metadata.
  const agentName = process.env.TELEPHONY_AGENT_NAME ?? "";
  const client = new AgentDispatchClient(url, key, secret);
  return {
    async dispatch(roomName, metadata) {
      await client.createDispatch(roomName, agentName, { metadata: JSON.stringify(metadata) });
    },
  };
}

export interface TickReport {
  reconciled: number;
  dispatched: number;
  failedDispatches: number;
  paused: number;
  completed: number;
}

export async function dialTick(
  db: Database,
  dispatcher: Dispatcher,
  now: Date = new Date(),
): Promise<TickReport> {
  const report: TickReport = { reconciled: 0, dispatched: 0, failedDispatches: 0, paused: 0, completed: 0 };

  report.reconciled = await reconcile(db, now);

  const running = await db.select().from(campaigns).where(eq(campaigns.status, "running"));
  for (const campaign of running) {
    const result = await dialCampaign(db, dispatcher, campaign, now);
    report.dispatched += result.dispatched;
    report.failedDispatches += result.failedDispatches;
    if (result.paused) report.paused += 1;
  }

  report.completed = await completeFinished(db, now);
  return report;
}

// --- reconciling --------------------------------------------------------------

function policyOf(raw: unknown): RetryPolicy {
  try {
    return validateRetryPolicy(raw);
  } catch {
    // Stored policies are validated on write; one that no longer passes is
    // treated as the default rather than stopping every contact behind it.
    return validateRetryPolicy(undefined);
  }
}

/** Moves every finished attempt on. Returns how many contacts moved. */
export async function reconcile(db: Database, now: Date): Promise<number> {
  let moved = 0;

  // Attempts whose call has ended, however it ended.
  const finished = await db
    .select({
      id: campaignContacts.id,
      attempts: campaignContacts.attempts,
      callStatus: calls.status,
      endReason: calls.endReason,
      retryPolicy: campaigns.retryPolicy,
    })
    .from(campaignContacts)
    .innerJoin(calls, eq(calls.id, campaignContacts.lastCallId))
    .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
    .where(
      and(
        eq(campaignContacts.status, "dialing"),
        notInArray(calls.status, ["ringing", "in_progress"]),
      ),
    );

  for (const row of finished) {
    const next = afterAttempt(policyOf(row.retryPolicy), row.attempts, row.callStatus, row.endReason, now);
    moved += await moveOn(db, row.id, next, row.callStatus, now);
  }

  // Attempts that never became a call at all.
  const lost = await db
    .select({
      id: campaignContacts.id,
      attempts: campaignContacts.attempts,
      retryPolicy: campaigns.retryPolicy,
    })
    .from(campaignContacts)
    .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
    .where(
      and(
        eq(campaignContacts.status, "dialing"),
        isNull(campaignContacts.lastCallId),
        lt(campaignContacts.lastAttemptAt, new Date(now.getTime() - NEVER_CONNECTED_AFTER_MS)),
      ),
    );

  for (const row of lost) {
    const next = afterAttempt(policyOf(row.retryPolicy), row.attempts, "failed", "never_connected", now);
    moved += await moveOn(db, row.id, next, "never_connected", now);
  }

  return moved;
}

async function moveOn(
  db: Database,
  contactId: string,
  next: ReturnType<typeof afterAttempt>,
  outcome: string,
  now: Date,
): Promise<number> {
  // Conditional on still dialing, so two dialers reconciling the same contact
  // move it once.
  const updated = await db
    .update(campaignContacts)
    .set({ status: next.status, nextAttemptAt: next.nextAttemptAt, lastOutcome: outcome, updatedAt: now })
    .where(and(eq(campaignContacts.id, contactId), eq(campaignContacts.status, "dialing")))
    .returning({ id: campaignContacts.id });
  return updated.length;
}

// --- dialling -----------------------------------------------------------------

type Campaign = typeof campaigns.$inferSelect;

async function pause(db: Database, campaign: Campaign, reason: string, now: Date) {
  console.warn(`dialer: pausing campaign ${campaign.id}: ${reason}`);
  await db
    .update(campaigns)
    .set({ status: "paused", statusReason: reason, updatedAt: now })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "running")));
}

/**
 * Why this campaign cannot place calls right now, or null if it can.
 *
 * Each of these would otherwise fail every call it placed, one at a time,
 * with a worker spun up for each -- so the campaign is paused instead, with a
 * reason a person can act on.
 */
async function blocker(db: Database, campaign: Campaign): Promise<string | null> {
  const balance = await standing(db, campaign.orgId);
  if (!balance.canPlaceCalls) return "out of credit";

  const agent = await db
    .select({ live: agents.liveVersionId, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, campaign.agentId), eq(agents.orgId, campaign.orgId)))
    .limit(1);
  if (!agent[0]?.live || agent[0].status !== "active") return "the agent has no published version";

  if (!(await callerId(db, campaign))) return "the caller ID number is no longer available";
  return null;
}

/** The number this campaign calls from, if it is still the organisation's. */
async function callerId(db: Database, campaign: Campaign) {
  if (!campaign.fromNumberId) return null;
  const rows = await db
    .select({ id: phoneNumbers.id, e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.id, campaign.fromNumberId),
        eq(phoneNumbers.orgId, campaign.orgId),
        eq(phoneNumbers.status, "assigned"),
        inArray(phoneNumbers.direction, ["outbound", "both"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

interface Claimed {
  id: string;
  e164: string;
  variables: unknown;
  attempts: number;
}

/**
 * Claims up to the campaign's free slots of due contacts.
 *
 * `includeIndia` is false outside the hours an Indian number may be called,
 * whatever the campaign's own schedule says.
 */
export async function claimContacts(
  db: Database,
  campaign: Campaign,
  now: Date,
  includeIndia: boolean,
): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`campaign:${campaign.id}`})) as locked`,
    );
    // Another dialer is working this campaign right now. It will fill the
    // slots; this one moves on rather than waiting.
    if (!lock[0]?.locked) return [];

    const inflight = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignContacts)
      .where(and(eq(campaignContacts.campaignId, campaign.id), eq(campaignContacts.status, "dialing")));
    const slots = campaign.concurrency - (inflight[0]?.n ?? 0);
    if (slots <= 0) return [];

    const candidates = await tx.execute<{ id: string; suppressed: boolean }>(sql`
      select c.id,
             exists (
               select 1 from suppressed_numbers s
               where s.org_id = c.org_id and s.e164 = c.e164
             ) as suppressed
      from campaign_contacts c
      where c.campaign_id = ${campaign.id}
        and c.status = 'pending'
        and (c.next_attempt_at is null or c.next_attempt_at <= ${now.toISOString()}::timestamptz)
        ${includeIndia ? sql`` : sql`and c.e164 not like '+91%'`}
      order by c.next_attempt_at nulls first, c.created_at
      limit ${slots}
      for update of c skip locked
    `);

    // Checked at the moment of dialling, not only at upload: someone who
    // asked not to be called after the list went in must still not be.
    const suppressed = candidates.filter((c) => c.suppressed).map((c) => c.id);
    const dial = candidates.filter((c) => !c.suppressed).map((c) => c.id);

    if (suppressed.length > 0) {
      await tx
        .update(campaignContacts)
        .set({ status: "suppressed", lastOutcome: "suppressed", updatedAt: now })
        .where(inArray(campaignContacts.id, suppressed));
    }
    if (dial.length === 0) return [];

    return tx
      .update(campaignContacts)
      .set({
        status: "dialing",
        attempts: sql`${campaignContacts.attempts} + 1`,
        lastAttemptAt: now,
        // Cleared, or reconciliation would read the previous attempt's
        // finished call and move this one on before it has even rung.
        lastCallId: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(inArray(campaignContacts.id, dial))
      .returning({
        id: campaignContacts.id,
        e164: campaignContacts.e164,
        variables: campaignContacts.variables,
        attempts: campaignContacts.attempts,
      });
  });
}

async function dialCampaign(
  db: Database,
  dispatcher: Dispatcher,
  campaign: Campaign,
  now: Date,
): Promise<{ dispatched: number; failedDispatches: number; paused: boolean }> {
  const idle = { dispatched: 0, failedDispatches: 0, paused: false };

  let schedule;
  try {
    schedule = validateSchedule(campaign.schedule);
  } catch {
    await pause(db, campaign, "the calling schedule is invalid", now);
    return { ...idle, paused: true };
  }
  if (!windowOpen(schedule, now)) return idle;

  const problem = await blocker(db, campaign);
  if (problem) {
    await pause(db, campaign, problem, now);
    return { ...idle, paused: true };
  }
  const from = (await callerId(db, campaign))!;

  const claimed = await claimContacts(db, campaign, now, indiaWindowOpen(now));
  let dispatched = 0;
  let failedDispatches = 0;

  for (const contact of claimed) {
    const roomName = `camp-${crypto.randomUUID().slice(0, 12)}`;
    try {
      await dispatcher.dispatch(roomName, {
        orgId: campaign.orgId,
        agentId: campaign.agentId,
        direction: "outbound",
        placeCall: true,
        toNumber: contact.e164,
        fromNumber: from.e164,
        phoneNumberId: from.id,
        variables: contact.variables,
        campaignId: campaign.id,
        contactId: contact.id,
      });
      dispatched += 1;
    } catch (error) {
      // Nothing was dialled, so the attempt is handed back rather than
      // counted: a worker fleet that is briefly down must not use up every
      // contact's attempts.
      failedDispatches += 1;
      console.error(`dialer: could not dispatch contact ${contact.id}: ${(error as Error).message}`);
      await db
        .update(campaignContacts)
        .set({
          status: "pending",
          attempts: sql`greatest(${campaignContacts.attempts} - 1, 0)`,
          nextAttemptAt: new Date(now.getTime() + DISPATCH_RETRY_MS),
          lastOutcome: "dispatch_failed",
          updatedAt: now,
        })
        .where(and(eq(campaignContacts.id, contact.id), eq(campaignContacts.status, "dialing")));
    }
  }

  return { dispatched, failedDispatches, paused: false };
}

// --- completing ---------------------------------------------------------------

/** Marks running campaigns with nobody left to call as completed. */
export async function completeFinished(db: Database, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const done = await tx
      .update(campaigns)
      .set({ status: "completed", statusReason: null, updatedAt: now })
      .where(
        and(
          eq(campaigns.status, "running"),
          sql`not exists (
            select 1 from ${campaignContacts}
            where ${campaignContacts.campaignId} = ${campaigns.id}
              and ${campaignContacts.status} in ('pending', 'dialing')
          )`,
        ),
      )
      .returning({ id: campaigns.id, orgId: campaigns.orgId, name: campaigns.name });

    for (const campaign of done) {
      const counts = await tx
        .select({ status: campaignContacts.status, n: sql<number>`count(*)::int` })
        .from(campaignContacts)
        .where(eq(campaignContacts.campaignId, campaign.id))
        .groupBy(campaignContacts.status);
      await enqueue(tx, campaign.orgId, "campaign.completed", `campaign.completed:${campaign.id}`, {
        id: campaign.id,
        name: campaign.name,
        completedAt: now.toISOString(),
        contacts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      });
    }
    return done.length;
  });
}
