import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema";

/** A fresh in-process Postgres with every committed migration applied. No network. */
export async function createTestDatabase() {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, client };
}

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>["db"];

/** The Postgres error behind a failed Drizzle query, for asserting on its code and constraint. */
export async function postgresError(
  query: PromiseLike<unknown>,
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await query;
  } catch (error) {
    let cause: unknown = error;
    while (cause instanceof Error && cause.cause) cause = cause.cause;
    return cause as { code?: string; constraint?: string; message: string };
  }
  throw new Error("expected the query to fail");
}
