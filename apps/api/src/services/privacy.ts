/**
 * Erasing a person's data on request.
 *
 * Under the DPDP Act a person can ask for their personal data to be erased.
 * Here that means everything tied to their phone number: the numbers on
 * their calls, what was said, the analysis, the recording, the values a
 * campaign held about them, and the webhook payloads still queued with any of
 * it.
 *
 * Calls are anonymised rather than deleted. Their usage records and ledger
 * entries are the organisation's financial records, which the law expects to
 * be kept, and deleting a call would delete those with it. What is left says
 * that a call of this length happened and what it cost -- not with whom, or
 * what was said.
 *
 * The do-not-call entry, if there is one, is kept: removing it would let a
 * campaign call the person again, which is the opposite of what they asked.
 */

import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { callEvents, calls, campaignContacts, webhookDeliveries } from "../db/schema";

export interface ErasureReport {
  calls: number;
  recordingsDeleted: number;
  recordingsFailed: string[];
  campaignContacts: number;
}

export async function erasePhoneNumber(
  db: Database,
  orgId: string,
  e164: string,
  store: { delete(key: string): Promise<unknown> } | null,
): Promise<ErasureReport> {
  const affected = await db
    .select({ id: calls.id, recordingKey: calls.recordingKey })
    .from(calls)
    .where(and(eq(calls.orgId, orgId), or(eq(calls.fromNumber, e164), eq(calls.toNumber, e164))));
  const callIds = affected.map((c) => c.id);

  // Recordings first, outside the transaction: an object store is not
  // transactional, and a failure is reported rather than hidden so the
  // request can be retried for the ones that failed.
  const report: ErasureReport = { calls: callIds.length, recordingsDeleted: 0, recordingsFailed: [], campaignContacts: 0 };
  for (const call of affected.filter((c) => c.recordingKey)) {
    if (!store) {
      report.recordingsFailed.push(call.recordingKey!);
      continue;
    }
    try {
      await store.delete(call.recordingKey!);
      report.recordingsDeleted += 1;
    } catch {
      report.recordingsFailed.push(call.recordingKey!);
    }
  }
  const failed = new Set(report.recordingsFailed);

  await db.transaction(async (tx) => {
    if (callIds.length > 0) {
      await tx.delete(callEvents).where(inArray(callEvents.callId, callIds));
      await tx
        .delete(webhookDeliveries)
        .where(and(eq(webhookDeliveries.orgId, orgId), inArray(webhookDeliveries.eventKey, callIds.map((id) => `call.ended:${id}`))));
      await tx
        .update(calls)
        .set({ fromNumber: null, toNumber: null, summary: null, analysis: null, qa: null, metadata: { erased: true } })
        .where(inArray(calls.id, callIds));
      // Only the keys whose objects are gone: a key whose delete failed is
      // kept, so the object can still be found and deleted on a retry.
      const cleared = affected.filter((c) => c.recordingKey && !failed.has(c.recordingKey)).map((c) => c.id);
      if (cleared.length > 0) {
        await tx.update(calls).set({ recordingKey: null }).where(and(inArray(calls.id, cleared), isNotNull(calls.recordingKey)));
      }
    }

    const contacts = await tx
      .select({ id: campaignContacts.id })
      .from(campaignContacts)
      .where(and(eq(campaignContacts.orgId, orgId), eq(campaignContacts.e164, e164)));
    for (const contact of contacts) {
      // The row stays, so a campaign's counts still add up; the number is
      // replaced with something unique that is not a number.
      await tx
        .update(campaignContacts)
        .set({
          e164: `erased:${contact.id}`,
          variables: {},
          // Anyone still waiting to be called is not called: there is no
          // number left to call, and they asked to be forgotten.
          status: sql`case when ${campaignContacts.status} = 'pending' then 'suppressed'::contact_status else ${campaignContacts.status} end`,
          updatedAt: new Date(),
        })
        .where(eq(campaignContacts.id, contact.id));
    }
    report.campaignContacts = contacts.length;
  });

  return report;
}
