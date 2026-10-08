import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";

const valid = {
  DATABASE_URL: "postgres://automitra:automitra@localhost:5432/automitra",
  INTERNAL_API_SECRET: "x".repeat(32),
  SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("config", () => {
  test("defaults the port and environment", () => {
    expect(loadConfig(valid)).toMatchObject({ PORT: 3000, NODE_ENV: "development" });
  });

  test("lists every invalid variable at once", () => {
    let error: unknown;
    try {
      loadConfig({ INTERNAL_API_SECRET: "short", NODE_ENV: "staging" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("INTERNAL_API_SECRET: must be at least 32 characters");
    expect(message).toContain("NODE_ENV");
    expect(message).toContain("production");
    expect(message).toContain("SECRETS_KEY");
  });

  test("rejects a database URL that is not Postgres", () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://localhost/x" })).toThrow(
      ConfigError,
    );
  });
});
