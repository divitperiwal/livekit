import type { Database } from "../db/database";
import {
  deleteExpiredRecordings,
  type RecordingDeleter,
} from "../modules/calls/recording-retention";
import { sweepStaleCalls } from "../modules/calls/sweep-stale-calls";
import type { SecretBox } from "../modules/secrets/secret-box";
import {
  deliverDueWebhooks,
  oldestUndeliveredUsageMs,
  pruneWebhookDeliveries,
  USAGE_UNDELIVERED_ALERT_MS,
  type DeliveryDependencies,
} from "../modules/webhooks/deliver";
import type { Job } from "./runner";

export type JobDependencies = {
  db: Database;
  secretBox: SecretBox;
  deleteRecording: RecordingDeleter;
  maxCallSeconds: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Tests only: replaces the guarded HTTP POST. */
  post?: DeliveryDependencies["post"];
};

const MINUTE = 60_000;

/** Every background loop. Each only calls a module and logs what it did; ALERT lines page someone. */
export function backgroundJobs(deps: JobDependencies): Job[] {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;
  return [
    {
      name: "deliver-webhooks",
      everyMs: 2_000,
      run: async () => {
        const counts = await deliverDueWebhooks({
          db: deps.db,
          secretBox: deps.secretBox,
          post: deps.post,
          now,
        });
        if (counts.retrying + counts.failed > 0) {
          log(
            `webhooks: ${counts.delivered} delivered, ${counts.retrying} retrying, ${counts.failed} failed`,
          );
        }
        if (counts.failed > 0) {
          log(
            `ALERT webhook-delivery-failed: ${counts.failed} delivery(ies) gave up after every retry`,
          );
        }
      },
    },
    {
      name: "usage-delivery-watch",
      everyMs: MINUTE,
      run: async () => {
        const waited = await oldestUndeliveredUsageMs(deps.db, now());
        if (waited !== null && waited > USAGE_UNDELIVERED_ALERT_MS) {
          log(
            `ALERT usage-undelivered: the oldest usage.recorded has waited ${Math.round(waited / MINUTE)} min; the account is not debiting`,
          );
        }
      },
    },
    {
      name: "sweep-stale-calls",
      everyMs: MINUTE,
      run: async () => {
        const swept = await sweepStaleCalls(deps.db, {
          now: now(),
          maxCallSeconds: deps.maxCallSeconds,
        });
        if (swept.lostDispatches > 0) {
          log(`ALERT lost-dispatch: ${swept.lostDispatches} queued call(s) never reached a worker`);
        }
        if (swept.lostWorkers > 0) {
          log(
            `ALERT lost-worker: ${swept.lostWorkers} call(s) outlived the longest call without finalizing`,
          );
        }
      },
    },
    {
      name: "recording-retention",
      everyMs: 60 * MINUTE,
      run: async () => {
        const result = await deleteExpiredRecordings(deps.db, deps.deleteRecording, { now: now() });
        if (result.deleted > 0) log(`retention: deleted ${result.deleted} expired recording(s)`);
        if (result.failed > 0) {
          log(
            `ALERT recording-retention: ${result.failed} expired recording(s) could not be deleted`,
          );
        }
      },
    },
    {
      name: "prune-webhook-deliveries",
      everyMs: 24 * 60 * MINUTE,
      run: async () => {
        const pruned = await pruneWebhookDeliveries(deps.db, now());
        if (pruned > 0) log(`pruned ${pruned} webhook deliveries older than 30 days`);
      },
    },
  ];
}
