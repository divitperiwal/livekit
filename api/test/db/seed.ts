import {
  accountLedger,
  accounts,
  agents,
  agentVersions,
  apiKeys,
  calls,
  orgs,
  usageRecords,
} from "../../src/db/schema";
import type { TestDatabase } from "./test-database";

export async function seedAccount(db: TestDatabase, slug = "automitra") {
  const [account] = await db.insert(accounts).values({ slug, name: slug }).returning();
  return account!;
}

export async function seedOrg(db: TestDatabase, accountId: string, externalId = "biz-1") {
  const [org] = await db
    .insert(orgs)
    .values({ accountId, externalId, name: externalId })
    .returning();
  return org!;
}

export async function seedAgentWithVersion(db: TestDatabase, orgId: string, slug = "receptionist") {
  const [agent] = await db.insert(agents).values({ orgId, name: slug, slug }).returning();
  const [version] = await db
    .insert(agentVersions)
    .values({
      orgId,
      agentId: agent!.id,
      version: 1,
      promptMode: "prepend_base_rules",
      instructions: "Answer questions about the clinic.",
      greeting: "Namaste!",
      config: {},
    })
    .returning();
  return { agent: agent!, version: version! };
}

export async function seedApiKey(db: TestDatabase, accountId: string, maxConcurrentCalls = 1) {
  const [key] = await db
    .insert(apiKeys)
    .values({
      accountId,
      name: "test key",
      prefix: `am_live_${crypto.randomUUID().slice(0, 8)}`,
      keyHash: crypto.randomUUID(),
      scopes: ["calls:write"],
      maxConcurrentCalls,
    })
    .returning();
  return key!;
}

/** A completed call with its usage record and ledger entry, as finalize writes them. */
export async function seedCallWithUsage(
  db: TestDatabase,
  ids: { accountId: string; orgId: string; agentId: string; agentVersionId: string },
  priceInr: string,
  billableSeconds = 60,
) {
  const [call] = await db
    .insert(calls)
    .values({
      orgId: ids.orgId,
      agentId: ids.agentId,
      agentVersionId: ids.agentVersionId,
      lkJobId: `job-${crypto.randomUUID()}`,
      direction: "inbound",
      status: "completed",
    })
    .returning();
  const [usage] = await db
    .insert(usageRecords)
    .values({
      accountId: ids.accountId,
      orgId: ids.orgId,
      callId: call!.id,
      billableSeconds,
      pstnSeconds: billableSeconds,
      sttSeconds: "0",
      ttsCharacters: 0,
      llmPromptTokens: 0,
      llmCachedTokens: 0,
      llmCompletionTokens: 0,
      sttModel: "saaras:v3",
      ttsModel: "bulbul:v3",
      llmModel: "sarvam-105b",
      sttCostInr: "0",
      ttsCostInr: "0",
      llmCostInr: "0",
      pstnCostInr: "0",
      totalCostInr: "0",
      priceInr,
    })
    .returning();
  await db.insert(accountLedger).values({
    accountId: ids.accountId,
    kind: "usage",
    amountInr: priceInr,
    usageRecordId: usage!.id,
    idempotencyKey: `usage:${usage!.id}`,
  });
  return { call: call!, usage: usage! };
}
