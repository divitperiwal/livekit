import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  type PgTableExtraConfigValue,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { at, createdAt, id, updatedAt } from "./columns";
import { orgs } from "./tenancy";

export const agentStatus = pgEnum("agent_status", ["active", "archived"]);

/**
 * Pointers only. Each pointer must name a version of this same agent (composite keys
 * below), so a call can never run another agent's version.
 */
export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: agentStatus("status").notNull().default("active"),
    draftVersionId: uuid("draft_version_id"),
    liveVersionId: uuid("live_version_id"),
    candidateVersionId: uuid("candidate_version_id"),
    candidatePercent: smallint("candidate_percent").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("agents_org_slug_key").on(t.orgId, t.slug),
    unique("agents_id_org_key").on(t.id, t.orgId),
    check("agents_candidate_percent_range", sql`${t.candidatePercent} between 0 and 100`),
    check(
      "agents_candidate_needs_version",
      sql`${t.candidatePercent} = 0 or ${t.candidateVersionId} is not null`,
    ),
    foreignKey({
      name: "agents_draft_version_fk",
      columns: [t.draftVersionId, t.id],
      foreignColumns: [agentVersions.id, agentVersions.agentId],
    }),
    foreignKey({
      name: "agents_live_version_fk",
      columns: [t.liveVersionId, t.id],
      foreignColumns: [agentVersions.id, agentVersions.agentId],
    }),
    foreignKey({
      name: "agents_candidate_version_fk",
      columns: [t.candidateVersionId, t.id],
      foreignColumns: [agentVersions.id, agentVersions.agentId],
    }),
  ],
);

export const promptMode = pgEnum("prompt_mode", ["prepend_base_rules", "verbatim"]);

/**
 * Never updated in place (guarantee 16): saving a draft writes a new row and moves
 * `agents.draft_version_id`. The one allowed change is stamping `published_at` /
 * `published_by` once; a trigger enforces both.
 */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    version: integer("version").notNull(),
    promptMode: promptMode("prompt_mode").notNull(),
    instructions: text("instructions").notNull(),
    greeting: text("greeting").notNull(),
    /** Stored camelCase form of AgentConfigModel. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    publishedAt: at("published_at"),
    publishedBy: text("published_by"),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("agent_versions_agent_version_key").on(t.agentId, t.version),
    unique("agent_versions_id_agent_key").on(t.id, t.agentId),
    unique("agent_versions_id_org_key").on(t.id, t.orgId),
    foreignKey({
      name: "agent_versions_agent_fk",
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
    }).onDelete("cascade"),
    check("agent_versions_version_positive", sql`${t.version} > 0`),
  ],
);
