import { describe, expect, test } from "bun:test";
import { BalanceChecker, type BalanceCheckTarget } from "../../src/modules/billing/balance-check";

const target: BalanceCheckTarget = {
  accountId: "acc-1",
  url: "https://automitra.example/balance",
  bearerSecret: "s3cret",
  orgExternalId: "biz-1",
};

function checkerAnswering(
  respond: (request: Request, signal?: AbortSignal) => Response | Promise<Response>,
) {
  const requests: Request[] = [];
  const failures: string[] = [];
  let clock = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.url : String(input), init);
    requests.push(request);
    return respond(request, init?.signal ?? undefined);
  };
  const checker = new BalanceChecker({
    fetch: fakeFetch as typeof fetch,
    now: () => clock,
    onFailure: (_target, reason) => failures.push(reason),
  });
  return { checker, requests, failures, advance: (ms: number) => (clock += ms) };
}

describe("balance check", () => {
  test("asks for the org by its external id, with the bearer secret", async () => {
    const { checker, requests } = checkerAnswering(() => Response.json({ availableInr: 120.5 }));
    expect(await checker.availableInr(target)).toBe(120.5);
    expect(new URL(requests[0]!.url).searchParams.get("orgId")).toBe("biz-1");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer s3cret");
  });

  test("an answer is reused for 30 s per org", async () => {
    const { checker, requests, advance } = checkerAnswering(() =>
      Response.json({ availableInr: 10 }),
    );
    await checker.availableInr(target);
    advance(29_000);
    await checker.availableInr(target);
    expect(requests).toHaveLength(1);
    advance(2_000);
    await checker.availableInr(target);
    await checker.availableInr({ ...target, orgExternalId: "biz-2" });
    expect(requests).toHaveLength(3);
  });

  test("fails open, with an alert, on an error status, a bad body or no answer", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("down", { status: 503 }),
      () => Response.json({ balance: 5 }),
      () => Promise.reject(new Error("connection refused")),
    ];
    for (const respond of answers) {
      const { checker, failures } = checkerAnswering(respond);
      expect(await checker.availableInr(target)).toBeNull();
      expect(failures).toHaveLength(1);
    }
  });

  test("gives up after 1 s", async () => {
    const { checker, failures } = checkerAnswering(
      (_request, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    );
    const started = performance.now();
    expect(await checker.availableInr(target)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(failures).toHaveLength(1);
  });
});
