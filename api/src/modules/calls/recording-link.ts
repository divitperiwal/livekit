import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/database";
import { calls } from "../../db/schema";
import { isUuid } from "../ids";

/** Short: anyone holding the link can download the audio until it expires. */
export const RECORDING_LINK_SECONDS = 300;

/** A signed GET URL for one object in the recordings bucket. */
export type RecordingLinker = (key: string, expiresInSeconds: number) => string;

export type RecordingLink = { url: string; expiresAt: string };

type RecordingLinkOutcome =
  { kind: "linked"; link: RecordingLink } | { kind: "no_call" } | { kind: "no_recording" };

/** A recording past its org's retention is gone, so it has no link either. */
export async function recordingLink(
  db: Database,
  org: { id: string },
  callId: string,
  input: { linker: RecordingLinker; now: Date },
): Promise<RecordingLinkOutcome> {
  if (!isUuid(callId)) return { kind: "no_call" };
  const [call] = await db
    .select({ key: calls.recordingKey, deletedAt: calls.recordingDeletedAt })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.orgId, org.id)));
  if (!call) return { kind: "no_call" };
  if (call.key === null || call.deletedAt !== null) return { kind: "no_recording" };
  const expiresAt = new Date(input.now.getTime() + RECORDING_LINK_SECONDS * 1000);
  return {
    kind: "linked",
    link: {
      url: input.linker(call.key, RECORDING_LINK_SECONDS),
      expiresAt: expiresAt.toISOString(),
    },
  };
}
