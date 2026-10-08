import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { Database } from "../../db/database";
import { callEvents, calls, usageRecords } from "../../db/schema";
import { isUuid } from "../ids";
import { toPublicCall } from "./public-call";

type OrgRef = { id: string; externalId: string };

/**
 * One call as the account sees it, with its transcript: everything `call.ended` carried,
 * so polling by call id recovers a lost webhook.
 */
export async function getCall(db: Database, org: OrgRef, callId: string) {
  if (!isUuid(callId)) return null;
  const [row] = await db
    .select({ call: calls, usage: usageRecords })
    .from(calls)
    .leftJoin(usageRecords, eq(usageRecords.callId, calls.id))
    .where(and(eq(calls.id, callId), eq(calls.orgId, org.id)));
  if (!row) return null;
  const transcript = await db
    .select({
      seq: callEvents.seq,
      role: callEvents.role,
      content: callEvents.content,
      at: callEvents.at,
    })
    .from(callEvents)
    .where(
      and(
        eq(callEvents.callId, callId),
        inArray(callEvents.type, ["user_message", "agent_message"]),
      ),
    )
    .orderBy(asc(callEvents.seq));
  return {
    ...toPublicCall(row.call, org, row.usage),
    transcript: transcript.map((line) => ({ ...line, at: line.at.toISOString() })),
  };
}

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(at ?? "");
  return Number.isNaN(createdAt.getTime()) || !isUuid(id) ? null : { createdAt, id };
}

/** Newest first. `before` is the `nextCursor` of the previous page. */
export async function listCalls(
  db: Database,
  org: OrgRef,
  page: { before?: string; limit: number; disposition?: string },
): Promise<
  { calls: ReturnType<typeof toPublicCall>[]; nextCursor: string | null } | { invalidCursor: true }
> {
  const cursor = page.before ? decodeCursor(page.before) : null;
  if (page.before && !cursor) return { invalidCursor: true };
  const rows = await db
    .select({ call: calls, usage: usageRecords })
    .from(calls)
    .leftJoin(usageRecords, eq(usageRecords.callId, calls.id))
    .where(
      and(
        eq(calls.orgId, org.id),
        page.disposition ? eq(calls.disposition, page.disposition) : undefined,
        cursor
          ? or(
              lt(calls.createdAt, cursor.createdAt),
              and(eq(calls.createdAt, cursor.createdAt), lt(calls.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(calls.createdAt), desc(calls.id))
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows.at(-1);
  return {
    calls: pageRows.map((row) => toPublicCall(row.call, org, row.usage)),
    nextCursor:
      rows.length > page.limit && last ? encodeCursor(last.call.createdAt, last.call.id) : null,
  };
}
