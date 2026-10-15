import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { safePost, safeRequest } from "../../src/modules/webhooks/safe-fetch";

/**
 * The timeout is a deadline for the whole request. Bun's `ClientRequest.setTimeout` never
 * fired against a server that accepts and stays silent, so one such webhook endpoint froze
 * every delivery, and a tool kept running after the caller had been told it failed.
 */
describe("a customer URL gets an answer within the timeout or an error", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        if (new URL(request.url).pathname === "/silent") return new Promise<Response>(() => {});
        // A byte every 300 ms: never idle for long, never done in time.
        let sent = 0;
        const body = new ReadableStream({
          async pull(controller) {
            await Bun.sleep(300);
            controller.enqueue(new TextEncoder().encode("x"));
            sent += 1;
            if (sent === 20) controller.close();
          },
        });
        return new Response(body);
      },
    });
  });
  afterAll(() => server.stop(true));

  const options = { timeoutMs: 1_000, allowHttp: true, allowAddress: () => true };
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

  async function elapsedUntilRefused(send: () => Promise<unknown>) {
    const started = performance.now();
    await expect(send()).rejects.toThrow("no answer within 1000 ms");
    return performance.now() - started;
  }

  test("a server that never answers", async () => {
    const elapsed = await elapsedUntilRefused(() =>
      safeRequest({ method: "GET", url: url("/silent"), headers: {} }, options),
    );
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a server that answers too slowly, a byte at a time", async () => {
    const elapsed = await elapsedUntilRefused(() =>
      safeRequest(
        { method: "GET", url: url("/trickle"), headers: {}, maxResponseBytes: 1_000 },
        options,
      ),
    );
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a webhook endpoint that never answers", async () => {
    const elapsed = await elapsedUntilRefused(() => safePost(url("/silent"), "{}", {}, options));
    expect(elapsed).toBeLessThan(2_000);
  });
});
