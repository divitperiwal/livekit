import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://automitra:automitra@localhost:5432/automitra",
  },
  // Migrations are reviewed and committed, never pushed straight to a
  // database. `drizzle-kit push` is convenient and is exactly how a production
  // schema drifts from what the repository says it is.
  strict: true,
  verbose: true,
});
