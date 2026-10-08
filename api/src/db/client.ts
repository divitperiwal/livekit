import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Database } from "./database";
import * as schema from "./schema";

export function connectDatabase(url: string): { db: Database; close: () => Promise<void> } {
  const client = postgres(url, { max: 10 });
  return { db: drizzle({ client, schema }), close: () => client.end() };
}
