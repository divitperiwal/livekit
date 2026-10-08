import { eq } from "drizzle-orm";
import type { AppendEventsRequest } from "../../contracts/internal";
import type { Database } from "../../db/database";
import { callEvents, calls, orgs } from "../../db/schema";
import { isUuid } from "../ids";
import { redactJson, redactText } from "../privacy/redact";

export type AppendEventsOutcome =
  | { kind: "appended"; inserted: number }
  | { kind: "not_found" | "forbidden" | "invalid"; reason: string };

/**
 * Idempotent on (call, `seq`): a retried batch inserts only what is new (guarantee 9).
 * With the org's redaction on, text is masked before it is written (guarantee 19).
 */
export async function appendEvents(
  db: Database,
  callId: string,
  request: AppendEventsRequest,
): Promise<AppendEventsOutcome> {
  if (!isUuid(callId)) return { kind: "not_found", reason: "no such call" };
  const [row] = await db
    .select({ orgId: calls.orgId, redactPii: orgs.redactPii })
    .from(calls)
    .innerJoin(orgs, eq(orgs.id, calls.orgId))
    .where(eq(calls.id, callId));
  if (!row) return { kind: "not_found", reason: "no such call" };
  if (row.orgId !== request.orgId) {
    return { kind: "forbidden", reason: "call belongs to another org" };
  }

  const values = [];
  for (const event of request.events) {
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime())) {
      return { kind: "invalid", reason: `event ${event.seq} has an unreadable time` };
    }
    values.push({
      callId,
      seq: event.seq,
      type: event.type,
      role: event.role,
      content: row.redactPii && event.content !== null ? redactText(event.content) : event.content,
      payload: row.redactPii ? redactJson(event.payload) : event.payload,
      at,
    });
  }

  const inserted = await db
    .insert(callEvents)
    .values(values)
    .onConflictDoNothing({ target: [callEvents.callId, callEvents.seq] })
    .returning({ id: callEvents.id });
  return { kind: "appended", inserted: inserted.length };
}
