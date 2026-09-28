/**
 * Creating campaigns, filling them with contacts, and moving them between
 * states. The dialing itself is `dialer.ts`.
 *
 * Every function takes the organisation from the caller's session and scopes
 * every query by it: a campaign id alone is never enough to reach a campaign.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { agents, campaignContacts, campaigns, phoneNumbers, suppressedNumbers } from "../db/schema";
import {
  CampaignInputError,
  validateConcurrency,
  validateRetryPolicy,
  validateSchedule,
  type ContactRow,
} from "./campaign-rules";

export class CampaignError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

export const MAX_CONTACTS_PER_UPLOAD = 50_000;
const INSERT_CHUNK = 1000;

type Campaign = typeof campaigns.$inferSelect;

export interface CampaignInput {
  name?: unknown;
  agentId?: unknown;
  fromNumberId?: unknown;
  schedule?: unknown;
  retryPolicy?: unknown;
  concurrency?: unknown;
}

async function checkAgent(db: Database, orgId: string, agentId: unknown): Promise<string> {
  if (typeof agentId !== "string") throw new CampaignInputError({ agentId: "is required" });
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1);
  if (!rows[0]) throw new CampaignInputError({ agentId: "is not one of this organisation's agents" });
  return agentId;
}

async function checkFromNumber(db: Database, orgId: string, id: unknown): Promise<string | null> {
  if (id === null || id === undefined || id === "") return null;
  if (typeof id !== "string") throw new CampaignInputError({ fromNumberId: "must be a phone number id" });
  const rows = await db
    .select({ direction: phoneNumbers.direction })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.id, id), eq(phoneNumbers.orgId, orgId), eq(phoneNumbers.status, "assigned")))
    .limit(1);
  if (!rows[0]) throw new CampaignInputError({ fromNumberId: "is not one of this organisation's numbers" });
  if (rows[0].direction === "inbound") {
    throw new CampaignInputError({ fromNumberId: "is an inbound-only number and cannot place calls" });
  }
  return id;
}

export async function createCampaign(db: Database, orgId: string, input: CampaignInput): Promise<Campaign> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CampaignInputError({ name: "is required" });

  const values = {
    orgId,
    name,
    agentId: await checkAgent(db, orgId, input.agentId),
    fromNumberId: await checkFromNumber(db, orgId, input.fromNumberId),
    schedule: validateSchedule(input.schedule),
    retryPolicy: validateRetryPolicy(input.retryPolicy),
    concurrency: validateConcurrency(input.concurrency),
  };
  return (await db.insert(campaigns).values(values).returning())[0]!;
}

export async function getCampaign(db: Database, orgId: string, id: string): Promise<Campaign> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)))
    .limit(1);
  if (!rows[0]) throw new CampaignError("no such campaign", 404);
  return rows[0];
}

const FINISHED = new Set(["completed", "cancelled"]);

export async function updateCampaign(
  db: Database,
  orgId: string,
  id: string,
  input: CampaignInput,
): Promise<Campaign> {
  const campaign = await getCampaign(db, orgId, id);
  if (FINISHED.has(campaign.status)) {
    throw new CampaignError(`a ${campaign.status} campaign cannot be changed`, 409);
  }

  const set: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new CampaignInputError({ name: "is required" });
    set.name = name;
  }
  if (input.agentId !== undefined) set.agentId = await checkAgent(db, orgId, input.agentId);
  if (input.fromNumberId !== undefined) set.fromNumberId = await checkFromNumber(db, orgId, input.fromNumberId);
  if (input.schedule !== undefined) set.schedule = validateSchedule(input.schedule);
  if (input.retryPolicy !== undefined) set.retryPolicy = validateRetryPolicy(input.retryPolicy);
  if (input.concurrency !== undefined) set.concurrency = validateConcurrency(input.concurrency);

  return (await db.update(campaigns).set(set).where(eq(campaigns.id, campaign.id)).returning())[0]!;
}

export interface AddContactsResult {
  added: number;
  /** Already on this campaign, or repeated within the upload. */
  duplicates: number;
  /** On the organisation's do-not-call list; added, but will never be dialled. */
  suppressed: number;
}

/**
 * Adds contacts to a campaign.
 *
 * A number already on the campaign is skipped rather than updated, so
 * uploading a list twice cannot reset anyone's attempts and call them again.
 * Numbers on the do-not-call list are kept, marked suppressed, so the upload
 * report can say why they will not be called.
 */
export async function addContacts(
  db: Database,
  orgId: string,
  campaignId: string,
  rows: ContactRow[],
): Promise<AddContactsResult> {
  const campaign = await getCampaign(db, orgId, campaignId);
  if (FINISHED.has(campaign.status)) {
    throw new CampaignError(`a ${campaign.status} campaign cannot take new contacts`, 409);
  }
  if (rows.length > MAX_CONTACTS_PER_UPLOAD) {
    throw new CampaignError(`at most ${MAX_CONTACTS_PER_UPLOAD} contacts per upload`, 422);
  }

  const result: AddContactsResult = { added: 0, duplicates: 0, suppressed: 0 };
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const numbers = [...new Set(chunk.map((r) => r.e164))];
    const blocked = new Set(
      (
        await db
          .select({ e164: suppressedNumbers.e164 })
          .from(suppressedNumbers)
          .where(and(eq(suppressedNumbers.orgId, orgId), inArray(suppressedNumbers.e164, numbers)))
      ).map((r) => r.e164),
    );

    const inserted = await db
      .insert(campaignContacts)
      .values(
        chunk.map((r) => ({
          campaignId,
          orgId,
          e164: r.e164,
          variables: r.variables,
          status: blocked.has(r.e164) ? ("suppressed" as const) : ("pending" as const),
          lastOutcome: blocked.has(r.e164) ? "suppressed" : null,
        })),
      )
      .onConflictDoNothing({ target: [campaignContacts.campaignId, campaignContacts.e164] })
      .returning({ status: campaignContacts.status });

    result.added += inserted.length;
    result.duplicates += chunk.length - inserted.length;
    result.suppressed += inserted.filter((r) => r.status === "suppressed").length;
  }
  return result;
}

export type CampaignAction = "start" | "pause" | "resume" | "cancel";

/**
 * Moves a campaign to its next state.
 *
 * Starting checks what would otherwise fail on every call: a caller ID that
 * belongs to the organisation, an agent with something published, and at
 * least one person to call.
 */
export async function changeStatus(
  db: Database,
  orgId: string,
  id: string,
  action: CampaignAction,
): Promise<Campaign> {
  const campaign = await getCampaign(db, orgId, id);
  const from = campaign.status;

  const allowed: Record<CampaignAction, string[]> = {
    start: ["draft", "scheduled"],
    resume: ["paused"],
    pause: ["running"],
    cancel: ["draft", "scheduled", "running", "paused"],
  };
  if (!allowed[action].includes(from)) {
    throw new CampaignError(`cannot ${action} a ${from} campaign`, 409);
  }

  if (action === "start" || action === "resume") {
    if (!campaign.fromNumberId) throw new CampaignError("choose a number to call from first", 422);
    await checkFromNumber(db, orgId, campaign.fromNumberId);

    const agent = await db
      .select({ live: agents.liveVersionId })
      .from(agents)
      .where(and(eq(agents.id, campaign.agentId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!agent[0]?.live) throw new CampaignError("the agent has no published version", 422);

    const due = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignContacts)
      .where(and(eq(campaignContacts.campaignId, id), inArray(campaignContacts.status, ["pending", "dialing"])));
    if ((due[0]?.n ?? 0) === 0) throw new CampaignError("there is nobody left to call on this campaign", 422);
  }

  const status = { start: "running", resume: "running", pause: "paused", cancel: "cancelled" }[action] as Campaign["status"];
  const updated = await db
    .update(campaigns)
    .set({ status, statusReason: null, updatedAt: new Date() })
    // Conditional on the state it was read in, so a dialer pausing the
    // campaign at the same moment is not silently overwritten.
    .where(and(eq(campaigns.id, id), eq(campaigns.status, from)))
    .returning();
  if (!updated[0]) throw new CampaignError("the campaign changed while this was being applied; try again", 409);
  return updated[0];
}

/** How many contacts are in each state, for the campaign's progress. */
export async function contactCounts(db: Database, campaignIds: string[]) {
  if (campaignIds.length === 0) return new Map<string, Record<string, number>>();
  const rows = await db
    .select({
      campaignId: campaignContacts.campaignId,
      status: campaignContacts.status,
      n: sql<number>`count(*)::int`,
    })
    .from(campaignContacts)
    .where(inArray(campaignContacts.campaignId, campaignIds))
    .groupBy(campaignContacts.campaignId, campaignContacts.status);

  const out = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const counts = out.get(row.campaignId) ?? {};
    counts[row.status] = row.n;
    out.set(row.campaignId, counts);
  }
  return out;
}
