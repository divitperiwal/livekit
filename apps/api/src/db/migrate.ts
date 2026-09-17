/**
 * Applies pending migrations. `bun run db:migrate`.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createClient, DATABASE_URL } from "./client";

// A migration runs in one transaction and takes an advisory lock; both need a
// single connection to mean anything.
const { sql, db } = createClient({ max: 1 });

// Never log the URL itself -- it carries the password.
console.log(`migrating ${new URL(DATABASE_URL).host}`);

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
} finally {
  await sql.end();
}
