/**
 * Tools: the HTTP endpoints an agent can call mid-conversation.
 *
 * A tool is a row, not code. Its JSON Schema goes to the model as a function
 * definition, and when the model calls it the worker POSTs the arguments to
 * `url`. Adding a tool is a dashboard action, not a deploy.
 *
 * The URL is customer-supplied and the platform makes server-side requests to
 * it, which is a server-side request forgery risk by construction. The
 * defences live in the worker, at the moment of the request -- validating here
 * would only check the string, and DNS can say something different by the time
 * the connection is made.
 */

import { boolean, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { agentVersions } from "./agents";
import { createdAt, id, orgs, updatedAt } from "./identity";

export const toolAuthType = pgEnum("tool_auth_type", [
  "none",
  "bearer",
  "header",
  "hmac",
]);

export const httpMethod = pgEnum("http_method", ["GET", "POST", "PUT", "PATCH"]);

export const tools = pgTable(
  "tools",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    /** What the model sees. The name must be a valid function identifier. */
    name: text("name").notNull(),

    /**
     * The description is not documentation -- it is the only thing telling the
     * model when to call this. A vague one produces a tool that is called at
     * the wrong moment or never at all.
     */
    description: text("description").notNull(),

    /** Raw JSON Schema for the arguments, passed to the model as-is. */
    parametersSchema: jsonb("parameters_schema").notNull(),

    method: httpMethod("method").notNull().default("POST"),
    url: text("url").notNull(),

    /** Non-secret headers. Anything sensitive belongs behind `authType`. */
    headers: jsonb("headers").notNull().default({}),
    authType: toolAuthType("auth_type").notNull().default("none"),

    /** Which header an `authType = "header"` secret is sent in, e.g. X-API-Key. */
    authHeader: text("auth_header"),

    /**
     * The bearer token, API key or HMAC secret, encrypted with
     * `SECRETS_KEY`. Never returned by the dashboard API once saved; only
     * the worker receives it decrypted, over the internal API, at the start of
     * a call. A database dump without the key reveals nothing usable.
     */
    authSecretCiphertext: text("auth_secret_ciphertext"),

    /**
     * A caller hears silence while a tool runs, so the ceiling is low by the
     * standards of a normal HTTP client. Anything slower than this needs the
     * agent to say "let me check that" first.
     */
    timeoutMs: integer("timeout_ms").notNull().default(5000),

    /**
     * Optional template to shrink the response before it reaches the model.
     * An endpoint returning a large document would otherwise fill the context
     * window, slow the reply and cost real money on every call.
     */
    responseTemplate: text("response_template"),

    /**
     * Marks a tool the agent should announce before calling, because it is
     * known to be slow.
     */
    isSlow: boolean("is_slow").notNull().default(false),

    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tools_org_name_key").on(t.orgId, t.name),
    index("tools_org_idx").on(t.orgId),
  ],
);

/**
 * Which tools a given version of an agent has.
 *
 * Attached to the version rather than the agent, so that a published version's
 * toolset is frozen along with its prompt. Removing a tool from an agent does
 * not change how a call that is already running behaves.
 */
export const agentTools = pgTable(
  "agent_tools",
  {
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_tools_pkey").on(t.agentVersionId, t.toolId),
    index("agent_tools_tool_idx").on(t.toolId),
  ],
);
