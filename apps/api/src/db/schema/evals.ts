/**
 * Test suites: simulated callers an agent is played against before release.
 *
 * A scenario is a caller and what a good call with them looks like. A run
 * plays every scenario of an agent against one version, in the worker (see
 * the worker's `evals.py`), and stores each conversation with its verdicts.
 */

import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { agents, agentVersions } from "./agents";
import { createdAt, id, orgs, updatedAt, users } from "./identity";

export const evalScenarios = pgTable(
  "eval_scenarios",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Who the caller is, what they want, how they talk. */
    caller: text("caller").notNull(),
    /** What the agent must do, each judged pass or fail. */
    criteria: text("criteria").array().notNull(),
    maxTurns: integer("max_turns").notNull().default(8),
    /** Filled into the prompt, as a campaign contact's columns would be. */
    variables: jsonb("variables").notNull().default({}),
    /** What each tool answers in this scenario, by name; tools are never really called. */
    toolResponses: jsonb("tool_responses").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("eval_scenarios_agent_idx").on(t.agentId)],
);

export const evalRunStatus = pgEnum("eval_run_status", ["queued", "running", "completed", "failed"]);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
    status: evalRunStatus("status").notNull().default("queued"),
    passed: integer("passed"),
    total: integer("total"),
    /** Tokens the run used: the agent, the simulated callers and the judge. */
    tokens: integer("tokens"),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("eval_runs_agent_idx").on(t.agentId, t.createdAt)],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    scenarioId: uuid("scenario_id").references(() => evalScenarios.id, { onDelete: "set null" }),
    /** Kept, so a result still reads sensibly after its scenario is deleted. */
    scenarioName: text("scenario_name").notNull(),
    passed: boolean("passed").notNull(),
    transcript: jsonb("transcript").notNull(),
    judgments: jsonb("judgments").notNull(),
    turns: integer("turns").notNull(),
    error: text("error"),
    tokens: integer("tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("eval_results_run_scenario_key").on(t.runId, t.scenarioId)],
);
