/**
 * The database connection.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://automitra:automitra@localhost:5432/automitra";

/**
 * Opens a pooled connection.
 *
 * Migrations and one-off scripts should pass `max: 1`: a migration has to run
 * on a single connection for its transaction and any advisory lock to mean
 * anything, and a script that opens a pool will hang at exit waiting for idle
 * connections it never uses.
 */
export function createClient(options: { max?: number } = {}) {
  const sql = postgres(DATABASE_URL, { max: options.max ?? 10 });
  return { sql, db: drizzle(sql, { schema }) };
}

export type Database = ReturnType<typeof createClient>["db"];
