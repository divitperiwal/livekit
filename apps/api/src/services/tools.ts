/**
 * Tools: validating them on save, and handing them to the worker at call time.
 *
 * The URL check here is the first of the SSRF layers described in the
 * worker's `ssrf.py` -- the one that tells a customer at the point of typing.
 * It is deliberately not the one relied on: a name that looks public today
 * can resolve to a private address tomorrow, so the worker checks the address
 * it actually connects to, every time.
 */

import { and, eq } from "drizzle-orm";
import { Ajv2020 as Ajv } from "ajv/dist/2020";

import type { Database } from "../db/client";
import { agentTools, tools } from "../db/schema";
import { decryptSecret, encryptSecret } from "./secrets";

/** Names the worker defines itself; a tool with one would shadow it. */
export const RESERVED_TOOL_NAMES = new Set(["end_call", "transfer_call", "search_knowledge"]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH"] as const;
const AUTH_TYPES = ["none", "bearer", "header", "hmac"] as const;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Headers the worker sets itself, or that would carry a secret in the clear. */
const UNSETTABLE_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "authorization",
]);

const MAX_SCHEMA_BYTES = 16 * 1024;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;

export class ToolInputError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(
      Object.entries(fieldErrors)
        .map(([field, message]) => `${field} ${message}`)
        .join("; "),
    );
    this.name = "ToolInputError";
  }
}

export interface ToolInput {
  name?: unknown;
  description?: unknown;
  parametersSchema?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  authType?: unknown;
  authHeader?: unknown;
  /** Write-only. Absent on an update means "keep the one already stored". */
  authSecret?: unknown;
  timeoutMs?: unknown;
  responseTemplate?: unknown;
  isSlow?: unknown;
  enabled?: unknown;
}

/**
 * The URL's shape: https, a normal port, a hostname rather than an address.
 *
 * An address literal is refused outright rather than range-checked. The forms
 * a resolver accepts -- decimal, hex, octal, IPv6 -- are many, and the worker
 * already knows them all; this side only has to be strict, not clever.
 */
export function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not carry credentials";
  if (url.port && url.port !== "443" && url.port !== "80") {
    return "may only use port 443 or 80";
  }
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || host.includes(":")) return "must be a hostname, not an address";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "must be a public hostname";
  }
  // A public DNS name has a dot and a top-level label that is not a number.
  const labels = host.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (labels.length < 2 || !/[a-z]/.test(tld)) return "must be a hostname, not an address";
  return null;
}

const ajv = new Ajv({ strict: false });

/**
 * Checks a tool, returning column values ready to write.
 *
 * `existing` makes it an update: absent fields keep their stored values, and
 * the rules are applied to the result, so an update cannot produce a tool a
 * create would have refused.
 */
export async function prepareTool(
  input: ToolInput,
  existing?: typeof tools.$inferSelect,
): Promise<Partial<typeof tools.$inferInsert>> {
  const errors: Record<string, string> = {};
  const out: Partial<typeof tools.$inferInsert> = {};
  const has = (key: keyof ToolInput) => input[key] !== undefined;

  if (!existing || has("name")) {
    const name = input.name;
    if (typeof name !== "string" || !NAME.test(name)) {
      errors.name = "must start with a letter or underscore and use only letters, digits and underscores (max 64)";
    } else if (RESERVED_TOOL_NAMES.has(name)) {
      errors.name = `is reserved for a built-in tool`;
    } else {
      out.name = name;
    }
  }

  if (!existing || has("description")) {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    // The model's only guide to when to call this. Empty means never, or at
    // random.
    if (!description) errors.description = "is required: it is how the agent knows when to use the tool";
    else if (description.length > 1000) errors.description = "must be at most 1000 characters";
    else out.description = description;
  }

  if (!existing || has("parametersSchema")) {
    const schema = input.parametersSchema ?? { type: "object", properties: {} };
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      errors.parametersSchema = "must be a JSON Schema object";
    } else if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
      errors.parametersSchema = "is too large";
    } else if ((schema as { type?: unknown }).type !== undefined && (schema as { type?: unknown }).type !== "object") {
      errors.parametersSchema = 'must have type "object"';
    } else {
      try {
        ajv.compile(schema);
        out.parametersSchema = { type: "object", properties: {}, ...(schema as object) };
      } catch (error) {
        errors.parametersSchema = `is not valid JSON Schema: ${(error as Error).message}`;
      }
    }
  }

  if (has("method")) {
    const method = typeof input.method === "string" ? input.method.toUpperCase() : "";
    if (!(METHODS as readonly string[]).includes(method)) errors.method = `must be one of: ${METHODS.join(", ")}`;
    else out.method = method as (typeof METHODS)[number];
  }

  if (!existing || has("url")) {
    const problem = typeof input.url === "string" ? urlProblem(input.url) : "is required";
    if (problem) errors.url = problem;
    else out.url = input.url as string;
  }

  if (has("headers")) {
    const headers = input.headers ?? {};
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      errors.headers = "must be an object of header names to values";
    } else {
      for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || typeof value !== "string") {
          errors.headers = `${name} is not a valid header`;
        } else if (UNSETTABLE_HEADERS.has(name.toLowerCase())) {
          errors.headers = `${name} cannot be set here; use the auth settings for credentials`;
        }
      }
      if (!errors.headers) out.headers = headers;
    }
  }

  const authType = (has("authType") ? input.authType : existing?.authType ?? "none") as string;
  if (!(AUTH_TYPES as readonly string[]).includes(authType)) {
    errors.authType = `must be one of: ${AUTH_TYPES.join(", ")}`;
  } else if (has("authType")) {
    out.authType = authType as (typeof AUTH_TYPES)[number];
  }

  if (has("authHeader")) {
    if (input.authHeader === null || input.authHeader === "") out.authHeader = null;
    else if (typeof input.authHeader !== "string" || !HEADER_NAME.test(input.authHeader)) {
      errors.authHeader = "is not a valid header name";
    } else if (UNSETTABLE_HEADERS.has(input.authHeader.toLowerCase())) {
      errors.authHeader = `cannot be ${input.authHeader}`;
    } else out.authHeader = input.authHeader;
  }

  if (has("authSecret") && input.authSecret !== null && input.authSecret !== "") {
    if (typeof input.authSecret !== "string" || input.authSecret.length > 4096) {
      errors.authSecret = "must be a string of at most 4096 characters";
    } else {
      out.authSecretCiphertext = await encryptSecret(input.authSecret);
    }
  } else if (has("authSecret")) {
    out.authSecretCiphertext = null;
  }
  const willHaveSecret =
    out.authSecretCiphertext !== undefined ? out.authSecretCiphertext !== null : Boolean(existing?.authSecretCiphertext);
  if (authType !== "none" && !willHaveSecret && !errors.authSecret) {
    errors.authSecret = `is required when authType is ${authType}`;
  }

  if (has("timeoutMs")) {
    const ms = input.timeoutMs;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
      errors.timeoutMs = `must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`;
    } else out.timeoutMs = ms;
  }

  if (has("responseTemplate")) {
    const template = input.responseTemplate;
    if (template === null || template === "") out.responseTemplate = null;
    else if (typeof template !== "string" || template.length > 2000) {
      errors.responseTemplate = "must be at most 2000 characters";
    } else out.responseTemplate = template;
  }

  for (const flag of ["isSlow", "enabled"] as const) {
    if (has(flag)) {
      if (typeof input[flag] !== "boolean") errors[flag] = "must be true or false";
      else out[flag] = input[flag] as boolean;
    }
  }

  if (Object.keys(errors).length > 0) throw new ToolInputError(errors);
  return out;
}

/** A tool as the dashboard sees it: everything except the secret. */
export function toolView(row: typeof tools.$inferSelect) {
  const { authSecretCiphertext, ...rest } = row;
  return { ...rest, hasSecret: Boolean(authSecretCiphertext) };
}

/** A tool as the worker needs it, secret included. */
export interface WorkerTool {
  name: string;
  description: string;
  parametersSchema: unknown;
  method: string;
  url: string;
  headers: unknown;
  authType: string;
  authHeader: string | null;
  authSecret: string | null;
  timeoutMs: number;
  responseTemplate: string | null;
  isSlow: boolean;
}

/**
 * The enabled tools on one agent version, with secrets decrypted.
 *
 * Never cached. The version's toolset is frozen, but a tool row is not -- its
 * URL or credentials can be changed or it can be disabled -- and a cached copy
 * would also put decrypted secrets in Redis.
 *
 * A tool whose secret cannot be read is left out rather than failing the
 * call: the agent can still hold a conversation without it, and the error
 * names the tool for whoever reads the logs.
 */
export async function toolsForVersion(db: Database, versionId: string): Promise<WorkerTool[]> {
  const rows = await db
    .select({ tool: tools })
    .from(agentTools)
    .innerJoin(tools, eq(tools.id, agentTools.toolId))
    .where(and(eq(agentTools.agentVersionId, versionId), eq(tools.enabled, true)))
    .orderBy(tools.name);

  const out: WorkerTool[] = [];
  for (const { tool } of rows) {
    let authSecret: string | null = null;
    if (tool.authSecretCiphertext) {
      try {
        authSecret = await decryptSecret(tool.authSecretCiphertext);
      } catch (error) {
        console.error(`tool ${tool.id} (${tool.name}): secret could not be decrypted: ${(error as Error).message}`);
        continue;
      }
    }
    out.push({
      name: tool.name,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
      method: tool.method,
      url: tool.url,
      headers: tool.headers,
      authType: tool.authType,
      authHeader: tool.authHeader,
      authSecret,
      timeoutMs: tool.timeoutMs,
      responseTemplate: tool.responseTemplate,
      isSlow: tool.isSlow,
    });
  }
  return out;
}
