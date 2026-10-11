import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/database";
import { orgs, phoneNumbers } from "../../db/schema";
import { errorMessage } from "../../error-message";
import { enqueueWebhook } from "../webhooks/enqueue";
import type { Plivo } from "./plivo";

export type ReleaseDependencies = { db: Database; plivo: Plivo; now?: () => Date };

export type ReleaseOutcome =
  | { kind: "released" }
  /** Plivo did not answer; the number is `releasing` and the release job tries again. */
  | { kind: "pending"; reason: string }
  | { kind: "not_found" };

/**
 * Gives a held number back to Plivo. It stops answering at once (no agent, `releasing`),
 * then Plivo is asked; a number is never reused for another business.
 */
export async function releaseHeldNumber(
  deps: ReleaseDependencies,
  e164: string,
): Promise<ReleaseOutcome> {
  const [number] = await deps.db
    .update(phoneNumbers)
    .set({ status: "releasing", agentId: null })
    .where(
      and(
        eq(phoneNumbers.e164, e164),
        isNull(phoneNumbers.releasedAt),
        inArray(phoneNumbers.status, ["assigned", "releasing"]),
      ),
    )
    .returning({ id: phoneNumbers.id });
  if (!number) return { kind: "not_found" };
  return finishRelease(deps, { id: number.id, e164 });
}

/** Asks Plivo, then marks the number released and tells its org's account. Safe to repeat. */
export async function finishRelease(
  deps: ReleaseDependencies,
  number: { id: string; e164: string },
): Promise<ReleaseOutcome> {
  try {
    await deps.plivo.releaseNumber(number.e164);
  } catch (error) {
    return { kind: "pending", reason: errorMessage(error) };
  }
  const now = deps.now?.() ?? new Date();
  await deps.db.transaction(async (tx) => {
    const [released] = await tx
      .update(phoneNumbers)
      .set({ status: "released", releasedAt: now })
      .where(and(eq(phoneNumbers.id, number.id), eq(phoneNumbers.status, "releasing")))
      .returning({ orgId: phoneNumbers.orgId });
    if (!released?.orgId) return;
    const [org] = await tx.select().from(orgs).where(eq(orgs.id, released.orgId));
    if (!org) return;
    await enqueueWebhook(tx, {
      accountId: org.accountId,
      orgId: org.id,
      type: "number.released",
      key: number.id,
      payload: { orgId: org.externalId, number: number.e164 },
    });
  });
  return { kind: "released" };
}

export type ReleaseRentedOutcome = ReleaseOutcome | { kind: "managed" };

/**
 * `/v1`: the account gives back a number it rented for this org. Numbers we assigned
 * (managed accounts) are released only from the ops CLI.
 */
export async function releaseRentedNumber(
  deps: ReleaseDependencies,
  orgId: string,
  e164: string,
): Promise<ReleaseRentedOutcome> {
  const [number] = await deps.db
    .select({ source: phoneNumbers.source, status: phoneNumbers.status })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.orgId, orgId),
        eq(phoneNumbers.e164, e164),
        isNull(phoneNumbers.releasedAt),
      ),
    );
  if (!number || number.status === "renting") return { kind: "not_found" };
  if (number.source === "managed") return { kind: "managed" };
  return releaseHeldNumber(deps, e164);
}

export type PendingReleaseResult = { released: number; pending: number; stuck: number };

/** A release Plivo has not confirmed for this long pages someone. */
export const RELEASE_STUCK_MS = 60 * 60_000;

/** Asks Plivo again for every number left `releasing` after a failed release. */
export async function retryPendingReleases(
  deps: ReleaseDependencies,
): Promise<PendingReleaseResult> {
  const now = deps.now?.() ?? new Date();
  const pending = await deps.db
    .select({ id: phoneNumbers.id, e164: phoneNumbers.e164, since: phoneNumbers.updatedAt })
    .from(phoneNumbers)
    .where(eq(phoneNumbers.status, "releasing"));
  const result: PendingReleaseResult = { released: 0, pending: 0, stuck: 0 };
  for (const number of pending) {
    const outcome = await finishRelease(deps, number);
    if (outcome.kind === "released") {
      result.released += 1;
      continue;
    }
    result.pending += 1;
    if (now.getTime() - number.since.getTime() > RELEASE_STUCK_MS) result.stuck += 1;
  }
  return result;
}
