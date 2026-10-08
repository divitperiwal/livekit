import { createApp } from "../../src/app";
import { INTERNAL_SECRET_HEADER } from "../../src/contracts/internal";
import type { CallDispatcher } from "../../src/livekit";
import { BalanceChecker } from "../../src/modules/billing/balance-check";
import { createTestDatabase } from "../db/test-database";
import { testSecretBox } from "../fixtures/secrets";

export const TEST_INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";

type TestAppOptions = {
  /** Answers the accounts' balance URLs. Default: no balance URL is ever called. */
  balance?: (request: Request) => Response | Promise<Response>;
  random?: () => number;
  /** Default: 2026-10-05 12:00 IST, inside Indian calling hours. */
  now?: () => Date;
  /** Default: records every dispatch and succeeds. Null: outbound calling not configured. */
  dispatcher?: CallDispatcher | null;
  ratePerMinute?: number;
};

export const TEST_NOW = new Date("2026-10-05T06:30:00Z");

/** The real app over a fresh in-process database, called without a network. */
export async function createTestApp(options: TestAppOptions = {}) {
  const { db } = await createTestDatabase();
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (!options.balance) throw new Error("unexpected balance check");
    return options.balance(new Request(input instanceof Request ? input.url : String(input), init));
  };
  const balanceChecker = new BalanceChecker({
    fetch: fakeFetch as typeof fetch,
    onFailure: () => {},
  });
  const dispatches: Parameters<CallDispatcher>[0][] = [];
  const recordingDispatcher: CallDispatcher = async (dispatch) => {
    dispatches.push(dispatch);
  };
  const app = createApp({
    db,
    config: { INTERNAL_API_SECRET: TEST_INTERNAL_SECRET },
    balanceChecker,
    secretBox: testSecretBox,
    dispatcher: options.dispatcher === undefined ? recordingDispatcher : options.dispatcher,
    roomPrefix: "call",
    ratePerMinute: options.ratePerMinute ?? 1_000,
    random: options.random,
    now: options.now ?? (() => TEST_NOW),
  });

  const internal = (
    path: string,
    init: RequestInit = {},
    secret: string | null = TEST_INTERNAL_SECRET,
  ) => {
    const headers = new Headers(init.headers);
    if (secret !== null) headers.set(INTERNAL_SECRET_HEADER, secret);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return app.request(`/internal${path}`, { ...init, headers });
  };

  const json = (path: string, body: unknown) =>
    internal(path, { method: "POST", body: JSON.stringify(body) });

  /** A /v1 request with an API key; the body, when given, is sent as JSON. */
  const v1 = async (key: string | null, method: string, path: string, body?: unknown) => {
    const headers = new Headers();
    if (key !== null) headers.set("authorization", `Bearer ${key}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await app.request(`/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };

  return { app, db, internal, json, v1, dispatches };
}
