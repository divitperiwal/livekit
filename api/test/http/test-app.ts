import { createApp } from "../../src/app";
import { INTERNAL_SECRET_HEADER } from "../../src/contracts/internal";
import type { CallDispatcher } from "../../src/livekit";
import { BalanceChecker } from "../../src/modules/billing/balance-check";
import type { RecordingLinker } from "../../src/modules/calls/recording-link";
import type { NumberServices } from "../../src/modules/numbers/number-services";
import { createTestDatabase } from "../db/test-database";
import { FakePlivo } from "../fixtures/fake-plivo";
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
  /** Default: a fake Plivo. Null: renting and KYC not configured. */
  plivo?: FakePlivo | null;
  /** Default: links to TEST_RECORDINGS_URL. Null: recording storage not configured. */
  recordingLinker?: RecordingLinker | null;
};

export const TEST_RECORDINGS_URL = "https://recordings.example";
const fakeRecordingLinker: RecordingLinker = (key, expiresInSeconds) =>
  `${TEST_RECORDINGS_URL}/${key}?expires-in=${expiresInSeconds}`;

export const TEST_INBOUND_TRUNK = "trunk-in-test";
export const TEST_PUBLIC_BASE_URL = "https://voice.example";

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
  const plivo = options.plivo === undefined ? new FakePlivo() : options.plivo;
  const numbers: NumberServices | null = plivo && {
    plivo,
    inboundTrunkId: TEST_INBOUND_TRUNK,
    publicBaseUrl: TEST_PUBLIC_BASE_URL,
    callbackSecret: "test-callback-secret",
  };
  const app = createApp({
    db,
    config: { INTERNAL_API_SECRET: TEST_INTERNAL_SECRET },
    balanceChecker,
    secretBox: testSecretBox,
    dispatcher: options.dispatcher === undefined ? recordingDispatcher : options.dispatcher,
    numbers,
    recordingLinker:
      options.recordingLinker === undefined ? fakeRecordingLinker : options.recordingLinker,
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

  /** A /v1 request with an API key; a FormData body is sent as multipart, anything else as JSON. */
  const v1 = async (
    key: string | null,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const headers = new Headers(extraHeaders);
    if (key !== null) headers.set("authorization", `Bearer ${key}`);
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers.set("content-type", "application/json");
    const response = await app.request(`/v1${path}`, {
      method,
      headers,
      body: body === undefined || isForm ? (body as FormData | undefined) : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };

  return { app, db, internal, json, v1, dispatches, plivo };
}
