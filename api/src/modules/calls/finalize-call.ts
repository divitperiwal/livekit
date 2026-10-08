import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  CallAnalysis,
  CallStatus,
  FinalizeCallRequest,
  UsageReport,
} from "../../contracts/internal";
import { onlyRow, type Database, type DatabaseTransaction } from "../../db/database";
import {
  accountLedger,
  accounts,
  callEvents,
  calls,
  orgs,
  suppressedNumbers,
  usageRecords,
} from "../../db/schema";
import { billableSecondsThisMonth, unpaidUsageInr } from "../billing/account-usage";
import { priceCall, roundPriceInr, type PricedCall } from "../billing/pricing";
import { findRateCard } from "../billing/rate-card";
import { isUuid } from "../ids";
import { redactJson, redactText } from "../privacy/redact";
import { enqueueWebhook } from "../webhooks/enqueue";
import { toPublicCall } from "./public-call";

export type FinalizeCallOutcome =
  | { kind: "finalized"; call: { id: string; status: CallStatus } }
  | { kind: "not_found"; reason: string };

/** At this share of the credit cap, the account is warned once. */
export const CREDIT_LOW_SHARE = 0.8;

type CallRow = typeof calls.$inferSelect;
type OrgRow = typeof orgs.$inferSelect;
type UsageRecordRow = typeof usageRecords.$inferSelect;

const noSuchCall: FinalizeCallOutcome = { kind: "not_found", reason: "no such call" };

/** The other party: who called us, or whom we called. */
function remoteNumber(call: CallRow): string | null {
  return call.direction === "inbound" ? call.fromNumber : call.toNumber;
}

/**
 * Closes a call once, idempotent on the call id (guarantee 9): a retried finalize returns
 * the first result and charges nothing twice. In one transaction: the call's outcome, a
 * do-not-call entry if asked, the priced usage record, its ledger entry, and the
 * `call.ended` / `usage.recorded` webhooks.
 */
export async function finalizeCall(
  db: Database,
  callId: string,
  request: FinalizeCallRequest,
  now = new Date(),
): Promise<FinalizeCallOutcome> {
  if (!isUuid(callId)) return noSuchCall;

  return db.transaction(async (tx): Promise<FinalizeCallOutcome> => {
    const [row] = await tx
      .select({ call: calls, org: orgs })
      .from(calls)
      .innerJoin(orgs, eq(orgs.id, calls.orgId))
      .where(eq(calls.id, callId))
      .for("update", { of: calls });
    if (!row) return noSuchCall;

    const { org } = row;
    if (row.call.finalizedAt !== null) {
      const firstResult = { id: row.call.id, status: row.call.status as CallStatus };
      return { kind: "finalized", call: firstResult };
    }

    const call = await closeCall(tx, row.call, org, request, now);

    if (request.doNotCall) await addToDoNotCall(tx, call, org);

    const usage = request.usage
      ? await recordUsage(tx, call, org, request.usage, request.durationSeconds, now)
      : null;

    await enqueueWebhook(tx, {
      accountId: org.accountId,
      orgId: org.id,
      type: "call.ended",
      key: call.id,
      payload: {
        call: toPublicCall(call, org, usage),
        transcript: await transcriptOf(tx, call.id),
      },
    });

    return { kind: "finalized", call: { id: call.id, status: request.status } };
  });
}

async function closeCall(
  tx: DatabaseTransaction,
  call: CallRow,
  org: OrgRow,
  request: FinalizeCallRequest,
  now: Date,
): Promise<CallRow> {
  const answered = call.answered || request.durationSeconds > 0;
  // Set by the open when the call was already answered; otherwise worked back from the duration.
  let answeredAt = call.answeredAt;
  if (answeredAt === null && answered) {
    answeredAt = new Date(now.getTime() - request.durationSeconds * 1000);
  }

  return tx
    .update(calls)
    .set({
      status: request.status,
      endReason: request.endReason,
      answered,
      answeredAt,
      endedAt: now,
      finalizedAt: now,
      durationSeconds: request.durationSeconds,
      recordingKey: request.recordingKey,
      latency: request.latency,
      ...analysisColumns(request.analysis, org.redactPii),
    })
    .where(eq(calls.id, call.id))
    .returning()
    .then(onlyRow);
}

/** The analysis as stored on the call, with PII masked when the org asks (guarantee 19). */
function analysisColumns(analysis: CallAnalysis | null, redactPii: boolean) {
  if (!analysis) return { summary: null, disposition: null, analysisFields: null, qa: null };

  const summary = analysis.summary ?? null;
  return {
    summary: summary !== null && redactPii ? redactText(summary) : summary,
    disposition: analysis.disposition ?? null,
    analysisFields: redactPii ? redactJson(analysis.fields) : analysis.fields,
    qa: analysis.qa ?? null,
  };
}

async function addToDoNotCall(tx: DatabaseTransaction, call: CallRow, org: OrgRow) {
  const number = remoteNumber(call);
  if (!number) return;
  await tx
    .insert(suppressedNumbers)
    .values({
      orgId: org.id,
      e164: number,
      source: "caller_request",
      reason: "asked on the call",
      callId: call.id,
    })
    .onConflictDoNothing({ target: [suppressedNumbers.orgId, suppressedNumbers.e164] });
}

async function transcriptOf(tx: DatabaseTransaction, callId: string) {
  const lines = await tx
    .select({
      seq: callEvents.seq,
      role: callEvents.role,
      content: callEvents.content,
      at: callEvents.at,
    })
    .from(callEvents)
    .where(
      and(
        eq(callEvents.callId, callId),
        inArray(callEvents.type, ["user_message", "agent_message"]),
      ),
    )
    .orderBy(asc(callEvents.seq));
  return lines.map((line) => ({ ...line, at: line.at.toISOString() }));
}

/** Prices by the rate card in effect when the call started. Without a card: free, and flagged. */
async function priceUsage(
  tx: DatabaseTransaction,
  call: CallRow,
  org: OrgRow,
  usage: UsageReport,
  durationSeconds: number,
  now: Date,
): Promise<PricedCall & { rateCardId: string | null }> {
  const card = await findRateCard(tx, org.accountId, call.startedAt ?? call.createdAt);
  if (!card) {
    return {
      rateCardId: null,
      billableSeconds: durationSeconds,
      sttCostInr: 0,
      ttsCostInr: 0,
      llmCostInr: 0,
      pstnCostInr: 0,
      totalCostInr: 0,
      priceInr: 0,
      reviewReasons: ["no rate card in effect"],
    };
  }

  const usedSecondsThisMonth = await billableSecondsThisMonth(tx, org.accountId, now);
  const priced = priceCall({
    rates: card.rates,
    usage,
    durationSeconds,
    remoteNumber: remoteNumber(call),
    includedSecondsLeft: card.rates.includedMinutes * 60 - usedSecondsThisMonth,
  });
  return { rateCardId: card.id, ...priced };
}

/** The usage record, its ledger debit, the `usage.recorded` webhook, and a credit-low warning. */
async function recordUsage(
  tx: DatabaseTransaction,
  call: CallRow,
  org: OrgRow,
  usage: UsageReport,
  durationSeconds: number,
  now: Date,
): Promise<UsageRecordRow> {
  const priced = await priceUsage(tx, call, org, usage, durationSeconds, now);
  const needsReview = priced.reviewReasons.length > 0;

  const record = await tx
    .insert(usageRecords)
    .values({
      accountId: org.accountId,
      orgId: org.id,
      callId: call.id,
      rateCardId: priced.rateCardId,
      billableSeconds: priced.billableSeconds,
      pstnSeconds: priced.billableSeconds,
      sttSeconds: String(usage.sttSeconds),
      ttsCharacters: usage.ttsCharacters,
      llmPromptTokens: usage.llmPromptTokens,
      llmCachedTokens: usage.llmCachedTokens,
      llmCompletionTokens: usage.llmCompletionTokens,
      sttModel: usage.sttModel,
      ttsModel: usage.ttsModel,
      llmModel: usage.llmModel,
      sttCostInr: String(priced.sttCostInr),
      ttsCostInr: String(priced.ttsCostInr),
      llmCostInr: String(priced.llmCostInr),
      pstnCostInr: String(priced.pstnCostInr),
      totalCostInr: String(priced.totalCostInr),
      priceInr: String(priced.priceInr),
      needsReview,
      reviewReason: needsReview ? priced.reviewReasons.join("; ") : null,
    })
    .returning()
    .then(onlyRow);

  const unpaidBefore = await unpaidUsageInr(tx, org.accountId);
  await tx.insert(accountLedger).values({
    accountId: org.accountId,
    kind: "usage",
    amountInr: record.priceInr,
    usageRecordId: record.id,
    idempotencyKey: `usage:${record.id}`,
    description: `call ${call.id}`,
  });

  await enqueueWebhook(tx, {
    accountId: org.accountId,
    orgId: org.id,
    type: "usage.recorded",
    key: record.id,
    payload: {
      orgId: org.externalId,
      callId: call.id,
      usageRecordId: record.id,
      priceInr: Number(record.priceInr),
    },
  });

  const unpaidAfter = unpaidBefore + Number(record.priceInr);
  await warnIfCreditLow(tx, org.accountId, unpaidBefore, unpaidAfter, record.id);
  return record;
}

/** Once, on the charge that crosses 80% of the cap: an alert for us and a webhook for the account. */
async function warnIfCreditLow(
  tx: DatabaseTransaction,
  accountId: string,
  unpaidBefore: number,
  unpaidAfter: number,
  usageRecordId: string,
) {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account || account.creditCapInr === null) return;

  const creditCapInr = Number(account.creditCapInr);
  const threshold = creditCapInr * CREDIT_LOW_SHARE;
  const crossedThreshold = unpaidBefore < threshold && unpaidAfter >= threshold;
  if (!crossedThreshold) return;

  const usedPercent = Math.round((unpaidAfter / creditCapInr) * 100);
  console.warn(
    `ALERT credit-low: account ${account.slug} has used ${usedPercent}% of its credit cap`,
  );
  await enqueueWebhook(tx, {
    accountId,
    orgId: null,
    type: "account.credit_low",
    key: usageRecordId,
    payload: { unpaidInr: roundPriceInr(unpaidAfter), creditCapInr },
  });
}
