import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/** Any Drizzle Postgres database over our schema: postgres.js in production, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** For `... returning()` on a row the statement must have written: `.then(onlyRow)`. */
export function onlyRow<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected the statement to return a row");
  return row;
}
