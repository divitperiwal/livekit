import { describe, expect, test } from "bun:test";
import { createTestApp, TEST_INTERNAL_SECRET } from "../http/test-app";

describe("guarantee 6: /internal/* rejects requests without the correct secret", () => {
  test("no secret is rejected", async () => {
    const { internal } = await createTestApp();
    const response = await internal("/resolve?agentId=x", {}, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing or wrong internal secret" });
  });

  test("a wrong secret of the same length is rejected", async () => {
    const { internal } = await createTestApp();
    const wrong =
      TEST_INTERNAL_SECRET.slice(0, -1) + (TEST_INTERNAL_SECRET.endsWith("f") ? "e" : "f");
    expect((await internal("/resolve?agentId=x", {}, wrong)).status).toBe(401);
  });

  test("a wrong secret of another length is rejected", async () => {
    const { internal } = await createTestApp();
    expect((await internal("/resolve?agentId=x", {}, "short")).status).toBe(401);
    expect((await internal("/resolve?agentId=x", {}, TEST_INTERNAL_SECRET + "x")).status).toBe(401);
  });

  test("writes are guarded too, before the body is read", async () => {
    const { internal } = await createTestApp();
    const response = await internal("/calls", { method: "POST", body: "not json" }, null);
    expect(response.status).toBe(401);
  });

  test("the correct secret gets past the guard", async () => {
    const { internal } = await createTestApp();
    const response = await internal("/no-such-route");
    expect(response.status).toBe(404);
  });
});
