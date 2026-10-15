import { eq } from "drizzle-orm";
import type { ToolCallRequest, ToolCallResponse } from "../../contracts/internal";
import type { Database } from "../../db/database";
import { accounts, agentVersions, calls, orgs } from "../../db/schema";
import { errorMessage } from "../../error-message";
import { isUuid } from "../ids";
import type { SecretBox } from "../secrets/secret-box";
import { safeRequest, type SafeRequest, type SafeResponse } from "../webhooks/safe-fetch";
import { findHttpTool, toolArgumentProblems, type HttpTool } from "./http-tools";
import { toolSignatureHeader } from "./tool-secret";

/** More than any answer the model should read; the rest is dropped unread. */
export const MAX_TOOL_RESPONSE_BYTES = 64 * 1024;
/** What the model reads: a longer answer costs tokens on every later turn of the call. */
export const MAX_TOOL_OUTPUT_CHARS = 4_000;
export const EMPTY_ANSWER = "The system answered with no content.";

/** Default: `safeRequest` through the SSRF guard (guarantee 5). */
export type ToolSender = (request: SafeRequest, timeoutMs: number) => Promise<SafeResponse>;

export type CallToolDependencies = {
  db: Database;
  secretBox: SecretBox;
  sendToolRequest?: ToolSender;
  now?: () => Date;
};

export type CallToolOutcome =
  | { kind: "called"; response: ToolCallResponse }
  | { kind: "not_found" | "forbidden" | "invalid" | "conflict"; reason: string };

type ToolRequestContext = {
  secret: string;
  timestamp: string;
  callId: string;
  orgExternalId: string;
  /** The other party: who rang in, or who was dialled. */
  callerNumber: string | null;
};

const sendSafely: ToolSender = (request, timeoutMs) => safeRequest(request, { timeoutMs });

/** GET puts the arguments in the query string, POST sends them as a JSON body; both are signed. */
export function toolRequest(
  tool: HttpTool,
  args: Record<string, unknown>,
  context: ToolRequestContext,
): SafeRequest {
  const url = new URL(tool.url);
  const given = Object.entries(args).filter(([, value]) => value !== null && value !== undefined);
  let body: string | undefined;
  if (tool.method === "GET") {
    for (const [name, value] of given) url.searchParams.append(name, String(value));
  } else {
    body = JSON.stringify(Object.fromEntries(given));
  }
  const signature = toolSignatureHeader(context.secret, {
    timestamp: context.timestamp,
    method: tool.method,
    pathAndQuery: `${url.pathname}${url.search}`,
    body: body ?? "",
  });
  const headers: Record<string, string> = {
    "x-automitra-timestamp": context.timestamp,
    "x-automitra-signature": signature,
    "x-automitra-tool": tool.name,
    "x-automitra-call-id": context.callId,
    "x-automitra-org-id": context.orgExternalId,
    "user-agent": "automitra-tools/1",
  };
  if (context.callerNumber) headers["x-automitra-caller"] = context.callerNumber;
  return {
    method: tool.method,
    url: url.toString(),
    headers,
    body,
    maxResponseBytes: MAX_TOOL_RESPONSE_BYTES,
  };
}

/** Any 2xx is an answer for the model; anything else, a failure it explains to the caller. */
export function toolResponse(answer: SafeResponse): ToolCallResponse {
  const succeeded = answer.status >= 200 && answer.status < 300;
  if (!succeeded) return { ok: false, statusCode: answer.status, output: `HTTP ${answer.status}` };
  const text = answer.body.trim();
  const isLong = text.length > MAX_TOOL_OUTPUT_CHARS;
  const output = isLong ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)} [truncated]` : text;
  return { ok: true, statusCode: answer.status, output: output || EMPTY_ANSWER };
}

async function findCall(db: Database, callId: string) {
  const [row] = await db
    .select({
      orgId: calls.orgId,
      direction: calls.direction,
      fromNumber: calls.fromNumber,
      toNumber: calls.toNumber,
      config: agentVersions.config,
      orgExternalId: orgs.externalId,
      toolSecretCiphertext: accounts.toolSecretCiphertext,
    })
    .from(calls)
    .innerJoin(agentVersions, eq(agentVersions.id, calls.agentVersionId))
    .innerJoin(orgs, eq(orgs.id, calls.orgId))
    .innerJoin(accounts, eq(accounts.id, orgs.accountId))
    .where(eq(calls.id, callId));
  return row ?? null;
}

/**
 * Calls one of the `httpTools` of the version the call runs, signed with the account's
 * secret. Sent once: the business's endpoint may act. A failing endpoint is an answer
 * (`ok` false), not an error; the model tells the caller.
 */
export async function callTool(
  dependencies: CallToolDependencies,
  callId: string,
  request: ToolCallRequest,
): Promise<CallToolOutcome> {
  const { db, secretBox, sendToolRequest = sendSafely, now = () => new Date() } = dependencies;
  if (!isUuid(callId)) return { kind: "not_found", reason: "no such call" };
  const call = await findCall(db, callId);
  if (!call) return { kind: "not_found", reason: "no such call" };
  if (call.orgId !== request.orgId) {
    return { kind: "forbidden", reason: "call belongs to another org" };
  }

  const tool = findHttpTool(call.config, request.name);
  if (!tool) return { kind: "not_found", reason: `the agent has no tool named ${request.name}` };
  const problems = toolArgumentProblems(tool, request.arguments);
  if (problems.length > 0) return { kind: "invalid", reason: problems.join("; ") };
  if (!call.toolSecretCiphertext) {
    return { kind: "conflict", reason: "the account has no tool signing secret" };
  }

  const outgoing = toolRequest(tool, request.arguments, {
    secret: secretBox.decrypt(call.toolSecretCiphertext),
    timestamp: String(Math.floor(now().getTime() / 1000)),
    callId,
    orgExternalId: call.orgExternalId,
    callerNumber: call.direction === "inbound" ? call.fromNumber : call.toNumber,
  });
  const host = new URL(tool.url).host;
  const started = performance.now();
  try {
    const response = toolResponse(await sendToolRequest(outgoing, tool.timeout * 1000));
    const elapsedMs = Math.round(performance.now() - started);
    console.log(
      `tool ${tool.name} (${host}) for call ${callId}: ${response.statusCode} in ${elapsedMs} ms`,
    );
    return { kind: "called", response };
  } catch (error) {
    console.warn(`tool ${tool.name} (${host}) for call ${callId} failed: ${errorMessage(error)}`);
    return {
      kind: "called",
      response: { ok: false, statusCode: null, output: errorMessage(error) },
    };
  }
}
