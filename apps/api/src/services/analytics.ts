/**
 * What an organisation's calls add up to.
 *
 * One query per question, each scoped by organisation and period, with the
 * optional agent and campaign filters applied the same way to all of them so
 * the numbers on one page always describe the same calls.
 *
 * Rates are over the calls where they mean something: the answer rate is over
 * outbound attempts (an inbound call was answered by definition), and the
 * latency percentiles are over calls that measured at least one whole turn.
 */

import { and, eq, gte, sql, type SQL } from "drizzle-orm";

import type { Database } from "../db/client";
import { agentVersions, calls } from "../db/schema";

export interface AnalyticsFilter {
  orgId: string;
  days: number;
  agentId?: string;
  campaignId?: string;
}

function where(f: AnalyticsFilter): SQL {
  return and(
    eq(calls.orgId, f.orgId),
    gte(calls.createdAt, sql`now() - make_interval(days => ${f.days})`),
    ...(f.agentId ? [eq(calls.agentId, f.agentId)] : []),
    ...(f.campaignId ? [sql`${calls.metadata}->>'campaignId' = ${f.campaignId}`] : []),
  )!;
}

export async function analytics(db: Database, f: AnalyticsFilter) {
  const filter = where(f);

  const [totals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      inbound: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')::int`,
      outbound: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')::int`,
      outboundAnswered: sql<number>`count(*) filter (where ${calls.direction} = 'outbound' and ${calls.answeredAt} is not null)::int`,
      voicemail: sql<number>`count(*) filter (where ${calls.status} = 'voicemail')::int`,
      completed: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
      transferred: sql<number>`count(*) filter (where ${calls.endReason} = 'transferred')::int`,
      avgDurationSeconds: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.durationSeconds} > 0), 0)::float`,
      priceInr: sql<number>`coalesce(sum(${calls.priceInr}), 0)::float`,
      costInr: sql<number>`coalesce(sum(${calls.costInr}), 0)::float`,
      latencyP50: sql<number | null>`percentile_cont(0.5) within group (order by (${calls.latency}->>'p50')::float)`,
      latencyP95: sql<number | null>`percentile_cont(0.95) within group (order by (${calls.latency}->>'p95')::float)`,
    })
    .from(calls)
    .where(filter);

  const dispositions = await db
    .select({ disposition: calls.disposition, calls: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(filter, sql`${calls.disposition} is not null`))
    .groupBy(calls.disposition)
    .orderBy(sql`count(*) desc`);

  const endReasons = await db
    .select({ status: calls.status, endReason: calls.endReason, calls: sql<number>`count(*)::int` })
    .from(calls)
    .where(filter)
    .groupBy(calls.status, calls.endReason)
    .orderBy(sql`count(*) desc`)
    .limit(15);

  const daily = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${calls.createdAt}), 'YYYY-MM-DD')`,
      calls: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${calls.answeredAt} is not null)::int`,
    })
    .from(calls)
    .where(filter)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // Per version, which is how an experiment is read: the same agent, two
  // versions, compared on the same measures.
  const versions = await db
    .select({
      agentVersionId: calls.agentVersionId,
      version: agentVersions.version,
      calls: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${calls.answeredAt} is not null)::int`,
      avgDurationSeconds: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.durationSeconds} > 0), 0)::float`,
      latencyP50: sql<number | null>`percentile_cont(0.5) within group (order by (${calls.latency}->>'p50')::float)`,
      // Each call's own pass rate, averaged across calls, so a call with ten
      // criteria does not outweigh one with two.
      qaPassRate: sql<number | null>`avg((
        select avg(case when e->>'passed' = 'true' then 1.0 when e->>'passed' = 'false' then 0.0 end)
        from jsonb_array_elements(coalesce(${calls.qa}, '[]'::jsonb)) as e
      ))::float`,
      dispositions: sql<Record<string, number> | null>`(
        select jsonb_object_agg(d.disposition, d.n) from (
          select c2.disposition, count(*)::int as n from calls c2
          where c2.agent_version_id = ${calls.agentVersionId} and c2.disposition is not null
            and c2.org_id = ${f.orgId} and c2.created_at >= now() - make_interval(days => ${f.days})
          group by c2.disposition
        ) d
      )`,
    })
    .from(calls)
    .leftJoin(agentVersions, eq(agentVersions.id, calls.agentVersionId))
    .where(filter)
    .groupBy(calls.agentVersionId, agentVersions.version)
    .orderBy(sql`count(*) desc`)
    .limit(20);

  return {
    period: { days: f.days },
    totals: {
      ...totals!,
      answerRate: totals!.outbound > 0 ? totals!.outboundAnswered / totals!.outbound : null,
    },
    dispositions,
    endReasons,
    daily,
    versions,
  };
}
