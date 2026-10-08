import { eq } from "drizzle-orm";
import { accounts, apiKeyScopes, orgs, phoneNumbers, rateCards } from "../../src/db/schema";
import { issueApiKey, type ApiKeyScope } from "../../src/modules/keys/api-keys";
import { seedLikeRates } from "../fixtures/rate-card";
import { createTestApp } from "./test-app";

export const ORG_NUMBER = "+918045001234";

export const agentBody = {
  name: "Receptionist",
  slug: "receptionist",
  instructions: "Book appointments for the clinic.",
  greeting: "Namaste, Sharma Clinic.",
  config: { ttsSpeaker: "ritu", ttsPace: 1.1 },
};

/**
 * automitra as a client of /v1: an account with a full-scope key, a global rate card,
 * and a pool number that `withOrgAndAgent` hands to the org (number assignment is not in
 * /v1 yet).
 */
export async function createV1Scenario(
  options: Parameters<typeof createTestApp>[0] & {
    account?: Partial<typeof accounts.$inferInsert>;
  } = {},
) {
  const testApp = await createTestApp(options);
  const { db } = testApp;
  const [account] = await db
    .insert(accounts)
    .values({ slug: "automitra", name: "automitra", ...options.account })
    .returning();
  await db
    .insert(rateCards)
    .values({ name: "seed", rates: seedLikeRates, effectiveFrom: new Date("2026-01-01") });

  const issue = async (
    input: {
      scopes?: readonly ApiKeyScope[];
      maxConcurrentCalls?: number;
      expiresAt?: Date | null;
      accountId?: string;
    } = {},
  ) =>
    (
      await issueApiKey(db, {
        accountId: input.accountId ?? account!.id,
        name: "test",
        maxConcurrentCalls: input.maxConcurrentCalls ?? 5,
        scopes: input.scopes ?? apiKeyScopes,
        expiresAt: input.expiresAt ?? null,
      })
    ).key;
  const key = await issue();
  const api = (method: string, path: string, body?: unknown) => testApp.v1(key, method, path, body);

  /** An org with a published agent answering, and calling from, ORG_NUMBER. */
  async function withOrgAndAgent(externalId = "clinic-42") {
    await api("PUT", `/orgs/${externalId}`, { name: "Sharma Clinic" });
    const agent = (await api("POST", `/orgs/${externalId}/agents`, agentBody)).body;
    await api("POST", `/orgs/${externalId}/agents/${agent.id}/publish`, {});
    const [org] = await db.select().from(orgs).where(eq(orgs.externalId, externalId));
    await db
      .insert(phoneNumbers)
      .values({ e164: ORG_NUMBER, orgId: org!.id, agentId: agent.id, status: "assigned" })
      .onConflictDoUpdate({
        target: phoneNumbers.e164,
        set: { orgId: org!.id, agentId: agent.id, status: "assigned" },
      });
    return { org: org!, agentId: agent.id as string };
  }

  return { ...testApp, account: account!, key, issue, api, withOrgAndAgent };
}
