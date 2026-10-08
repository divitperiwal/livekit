import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agentVersions } from "../../src/db/schema";
import { seedAccount, seedAgentWithVersion, seedOrg } from "../db/seed";
import { createTestDatabase, postgresError } from "../db/test-database";

describe("guarantee 16: agent versions are never updated in place", () => {
  async function oneDraftVersion() {
    const { db } = await createTestDatabase();
    const account = await seedAccount(db);
    const org = await seedOrg(db, account.id);
    const { version } = await seedAgentWithVersion(db, org.id);
    return { db, version };
  }

  test("a version's prompt cannot be edited", async () => {
    const { db, version } = await oneDraftVersion();
    const error = await postgresError(
      db
        .update(agentVersions)
        .set({ instructions: "Something else." })
        .where(eq(agentVersions.id, version.id)),
    );
    expect(error.message).toContain("immutable");
  });

  test("a version's config cannot be edited", async () => {
    const { db, version } = await oneDraftVersion();
    const error = await postgresError(
      db
        .update(agentVersions)
        .set({ config: { ttsPace: 2 } })
        .where(eq(agentVersions.id, version.id)),
    );
    expect(error.message).toContain("immutable");
  });

  test("publishing stamps a version once", async () => {
    const { db, version } = await oneDraftVersion();
    const [published] = await db
      .update(agentVersions)
      .set({ publishedAt: new Date(), publishedBy: "cli:ops" })
      .where(eq(agentVersions.id, version.id))
      .returning();
    expect(published!.publishedAt).not.toBeNull();

    const error = await postgresError(
      db
        .update(agentVersions)
        .set({ publishedAt: new Date() })
        .where(eq(agentVersions.id, version.id)),
    );
    expect(error.message).toContain("immutable");
  });

  test("publishing cannot smuggle in another change", async () => {
    const { db, version } = await oneDraftVersion();
    const error = await postgresError(
      db
        .update(agentVersions)
        .set({ publishedAt: new Date(), greeting: "Hello!" })
        .where(eq(agentVersions.id, version.id)),
    );
    expect(error.message).toContain("immutable");
  });
});
