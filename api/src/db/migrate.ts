/** Applies committed migrations (`drizzle/`) to DATABASE_URL. Run on every deploy, before the api starts. */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const client = postgres(url, { max: 1 });
await migrate(drizzle({ client }), {
  migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
});
await client.end();
console.log("migrations applied");
