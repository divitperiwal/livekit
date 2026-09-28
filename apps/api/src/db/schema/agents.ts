/**
 * Agents and their versions.
 *
 * An agent is a stable name and a pointer; everything that decides how a call
 * actually behaves lives on an immutable version row. Publishing writes a new
 * version and moves the pointer. Nothing is ever edited in place.
 *
 * That buys three things at once. A call in flight cannot have its prompt
 * changed underneath it -- it resolved a version id at the start and holds it
 * to the end. Every call record names the exact configuration that produced
 * it, so "why did it say that" is answerable months later. And because a
 * version can never change, a cache keyed on its id never needs invalidating:
 * a new version is simply a new key.
 */

import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, id, orgs, updatedAt, users } from "./identity";

export const agentStatus = pgEnum("agent_status", ["active", "archived"]);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: agentStatus("status").notNull().default("active"),

    /**
     * Two pointers, not one. The draft is what the editor writes to; the live
     * version is what calls resolve. They are deliberately separate so that
     * saving a half-finished prompt cannot affect a production number.
     *
     * Both are nullable: an agent exists before its first version does. The
     * foreign keys are added in a follow-up migration because the two tables
     * reference each other, and one of them has to be created first.
     */
    draftVersionId: uuid("draft_version_id"),
    liveVersionId: uuid("live_version_id"),

    /**
     * An experiment: this share of calls goes to the candidate version
     * instead of the live one, chosen per call. Both stay immutable, so every
     * call record still names exactly what it ran on, and analytics can
     * compare the two by disposition and latency. No FK, like the pointers
     * above; see migration 0002.
     */
    candidateVersionId: uuid("candidate_version_id"),
    candidatePercent: integer("candidate_percent").notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agents_org_slug_key").on(t.orgId, t.slug),
    index("agents_org_idx").on(t.orgId),
  ],
);

/**
 * How the agent's own prompt combines with the shared voice rules.
 *
 * `prepend_base_rules` is the normal case: the customer writes a personality
 * and the platform prepends the rules that follow from speech as a medium --
 * no markdown, stay brief, mirror the caller's language.
 *
 * `verbatim` is for a complete call script that sets its own rules. Prepending
 * the shared rules to such a prompt contradicts it: they open with "You are a
 * voice assistant" and tell the model to mirror the caller's language, which
 * an agent playing a named human on a scripted call must not do.
 *
 * The worker can express this today only through a code-level persona flag,
 * never through configuration. Making it a column is what lets a customer
 * build that kind of agent in the dashboard.
 */
export const promptMode = pgEnum("prompt_mode", ["prepend_base_rules", "verbatim"]);

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Denormalised from the agent so that every tenant-scoped query can filter
    // on this table directly, without a join.
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    /** Monotonic per agent, for display: "v3". */
    version: integer("version").notNull(),

    /**
     * The prompt and greeting are columns rather than part of `config` because
     * they are large, they are what a customer edits most, and they are what
     * you will want to diff between versions and search across.
     */
    promptMode: promptMode("prompt_mode").notNull().default("prepend_base_rules"),
    instructions: text("instructions").notNull(),
    greeting: text("greeting").notNull(),

    /**
     * Everything else: models, languages, voice, budgets, turn detection.
     *
     * Deliberately one jsonb column rather than twenty-five typed ones. These
     * knobs will be added to weekly for the first while, and a migration per
     * knob is friction with no safety benefit -- the shape is validated on
     * write against a schema generated from the worker's own config model,
     * which is the real source of truth for what a valid value is.
     */
    config: jsonb("config").notNull(),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_versions_agent_version_key").on(t.agentId, t.version),
    index("agent_versions_agent_idx").on(t.agentId),
    index("agent_versions_org_idx").on(t.orgId),
  ],
);
