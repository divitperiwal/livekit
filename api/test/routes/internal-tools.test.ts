import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts } from "../../src/db/schema";
import { EMPTY_ANSWER, MAX_TOOL_OUTPUT_CHARS } from "../../src/modules/tools/call-tool";
import type { SafeRequest, SafeResponse } from "../../src/modules/webhooks/safe-fetch";
import { testSecretBox } from "../fixtures/secrets";
import { CALLER_NUMBER, CLINIC_NUMBER, createScenario } from "../http/scenario";
import { TEST_NOW } from "../http/test-app";

const TOOL_SECRET = "tsec_test-secret";

const STOCK_TOOL = {
  name: "check_stock",
  description: "Animals in stock today.",
  url: "https://erp.example.in/api/stock?source=voice",
  timeout: 4,
  parameters: [
    { name: "animal", type: "enum", options: ["pig", "goat"] },
    { name: "breed", required: false },
  ],
};
const ORDER_TOOL = {
  name: "place_order",
  description: "Reserve animals for the caller.",
  method: "POST",
  url: "https://erp.example.in/api/orders",
  parameters: [
    { name: "animal", type: "enum", options: ["pig", "goat"] },
    { name: "quantity", type: "number" },
    { name: "delivery", type: "boolean", required: false },
  ],
};

type Sent = { request: SafeRequest; timeoutMs: number };

function businessSystem(answer: SafeResponse | Error = { status: 200, body: '{"pigs": 42}' }) {
  const sent: Sent[] = [];
  const sendToolRequest = async (request: SafeRequest, timeoutMs: number) => {
    sent.push({ request, timeoutMs });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { sent, sendToolRequest };
}

async function toolScenario(
  answer?: SafeResponse | Error,
  options: { toolSecret?: string | null } = {},
) {
  const system = businessSystem(answer);
  const secret = options.toolSecret === undefined ? TOOL_SECRET : options.toolSecret;
  const scenario = await createScenario({
    sendToolRequest: system.sendToolRequest,
    agentConfig: { httpTools: [STOCK_TOOL, ORDER_TOOL] },
    account: { toolSecretCiphertext: secret === null ? null : testSecretBox.encrypt(secret) },
  });
  const { body: call } = await scenario.open();
  return { ...scenario, ...system, callId: call.id as string };
}

function expectedSignature(signed: string) {
  return `sha256=${createHmac("sha256", TOOL_SECRET).update(signed).digest("hex")}`;
}

describe("POST /internal/calls/:id/tools", () => {
  test("a GET tool sends the arguments in the query, signed, and returns the answer", async () => {
    const { callTool, callId, sent } = await toolScenario();
    const { status, body } = await callTool(callId, {
      name: "check_stock",
      arguments: { animal: "pig", breed: null },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, statusCode: 200, output: '{"pigs": 42}' });
    const [{ request, timeoutMs }] = sent as [Sent];
    expect(timeoutMs).toBe(4_000);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://erp.example.in/api/stock?source=voice&animal=pig");
    expect(request.body).toBeUndefined();
    const timestamp = String(Math.floor(TEST_NOW.getTime() / 1000));
    expect(request.headers).toEqual({
      "x-automitra-timestamp": timestamp,
      "x-automitra-signature": expectedSignature(
        `${timestamp}.GET./api/stock?source=voice&animal=pig.`,
      ),
      "x-automitra-tool": "check_stock",
      "x-automitra-call-id": callId,
      "x-automitra-org-id": "clinic-42",
      "x-automitra-caller": CALLER_NUMBER,
      "user-agent": "automitra-tools/1",
    });
  });

  test("a POST tool sends the arguments as a signed JSON body", async () => {
    const { callTool, callId, sent } = await toolScenario({ status: 201, body: "reserved" });
    const { body } = await callTool(callId, {
      name: "place_order",
      arguments: { animal: "goat", quantity: 2, delivery: true },
    });

    expect(body).toEqual({ ok: true, statusCode: 201, output: "reserved" });
    const [{ request, timeoutMs }] = sent as [Sent];
    expect(timeoutMs).toBe(5_000);
    expect(request.body).toBe('{"animal":"goat","quantity":2,"delivery":true}');
    const timestamp = request.headers["x-automitra-timestamp"];
    expect(request.headers["x-automitra-signature"]).toBe(
      expectedSignature(`${timestamp}.POST./api/orders.${request.body}`),
    );
  });

  test("on an outbound call the caller is the number dialled", async () => {
    const scenario = await toolScenario();
    const { body: call } = await scenario.open({
      direction: "outbound",
      fromNumber: CLINIC_NUMBER,
      toNumber: CALLER_NUMBER,
    });
    await scenario.callTool(call.id, { name: "check_stock", arguments: { animal: "pig" } });
    expect(scenario.sent[0]!.request.headers["x-automitra-caller"]).toBe(CALLER_NUMBER);
  });

  test("a failing business system is an answer the model explains, not an error", async () => {
    const down = await toolScenario({ status: 503, body: "maintenance" });
    expect(
      (await down.callTool(down.callId, { name: "check_stock", arguments: { animal: "pig" } }))
        .body,
    ).toEqual({ ok: false, statusCode: 503, output: "HTTP 503" });

    const slow = await toolScenario(new Error("no answer within 4000 ms"));
    expect(
      (await slow.callTool(slow.callId, { name: "check_stock", arguments: { animal: "pig" } }))
        .body,
    ).toEqual({ ok: false, statusCode: null, output: "no answer within 4000 ms" });
  });

  test("a long answer is cut for the model; an empty one says so", async () => {
    const long = await toolScenario({ status: 200, body: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 50) });
    const { body } = await long.callTool(long.callId, {
      name: "check_stock",
      arguments: { animal: "pig" },
    });
    expect(body.output).toBe(`${"x".repeat(MAX_TOOL_OUTPUT_CHARS)} [truncated]`);

    const empty = await toolScenario({ status: 204, body: "" });
    const answer = await empty.callTool(empty.callId, {
      name: "check_stock",
      arguments: { animal: "pig" },
    });
    expect(answer.body.output).toBe(EMPTY_ANSWER);
  });

  test("arguments that do not fit the tool are refused with what to correct", async () => {
    const { callTool, callId, sent } = await toolScenario();
    const refused = await callTool(callId, {
      name: "place_order",
      arguments: { animal: "cow", quantity: "two", colour: "pink" },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe(
      "colour is not a parameter of place_order; animal must be one of pig, goat; " +
        "quantity must be a number",
    );
    const missing = await callTool(callId, { name: "check_stock", arguments: {} });
    expect(missing).toEqual({ status: 422, body: { error: "animal is required" } });
    const tooLong = await callTool(callId, {
      name: "check_stock",
      arguments: { animal: "pig", breed: "b".repeat(501) },
    });
    expect(tooLong.body.error).toBe("breed must be at most 500 characters");
    expect(sent).toHaveLength(0);
  });

  test("only the version's own tools, for the call's own org, with a secret", async () => {
    const { callTool, callId, ids, db, sent } = await toolScenario();
    expect(await callTool(callId, { name: "send_money", arguments: {} })).toEqual({
      status: 404,
      body: { error: "the agent has no tool named send_money" },
    });
    expect(
      (await callTool(callId, { name: "check_stock", orgId: crypto.randomUUID() })).status,
    ).toBe(403);
    expect((await callTool(crypto.randomUUID(), { name: "check_stock" })).status).toBe(404);

    await db
      .update(accounts)
      .set({ toolSecretCiphertext: null })
      .where(eq(accounts.id, ids.accountId));
    expect(await callTool(callId, { name: "check_stock", arguments: { animal: "pig" } })).toEqual({
      status: 409,
      body: { error: "the account has no tool signing secret" },
    });
    expect(sent).toHaveLength(0);
  });
});
