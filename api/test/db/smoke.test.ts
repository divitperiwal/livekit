import { expect, test } from "bun:test";
import { createTestDatabase } from "./test-database";
import { seedAccount } from "./seed";

test("migrations apply to an empty database", async () => {
  const { db } = await createTestDatabase();
  const account = await seedAccount(db);
  expect(account.status).toBe("active");
});
