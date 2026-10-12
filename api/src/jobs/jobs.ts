import type { Database } from "../db/database";
import { errorMessage } from "../error-message";
import {
  deleteExpiredRecordings,
  type RecordingDeleter,
} from "../modules/calls/recording-retention";
import { sweepStaleCalls } from "../modules/calls/sweep-stale-calls";
import { chargeMonthlyRent } from "../modules/numbers/monthly-rent";
import { pollNumberKyc } from "../modules/numbers/number-kyc";
import type { Plivo } from "../modules/numbers/plivo";
import { retryPendingReleases } from "../modules/numbers/release-number";
import { undoAbandonedRents } from "../modules/numbers/rent-number";
import { syncUccComplaints } from "../modules/numbers/ucc-complaints";
import type { SecretBox } from "../modules/secrets/secret-box";
import {
  BILLING_UNDELIVERED_ALERT_MS,
  deliverDueWebhooks,
  oldestUndeliveredMs,
  pruneWebhookDeliveries,
  type DeliveryDependencies,
} from "../modules/webhooks/deliver";
import type { Job } from "./runner";

export type JobDependencies = {
  db: Database;
  secretBox: SecretBox;
  deleteRecording: RecordingDeleter;
  maxCallSeconds: number;
  /** Null when Plivo is not configured: the number jobs do not run. */
  plivo: Plivo | null;
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
      name: "billing-delivery-watch",
      everyMs: MINUTE,
      run: async () => {
        const usageWaited = await oldestUndeliveredMs(deps.db, "usage.recorded", now());
        if (usageWaited !== null && usageWaited > BILLING_UNDELIVERED_ALERT_MS) {
          log(
            `ALERT usage-undelivered: the oldest usage.recorded has waited ${Math.round(usageWaited / MINUTE)} min; the account is not debiting`,
          );
        }
        const rentWaited = await oldestUndeliveredMs(deps.db, "number.rent_charged", now());
        if (rentWaited !== null && rentWaited > BILLING_UNDELIVERED_ALERT_MS) {
          log(
            `ALERT rent-undelivered: the oldest number.rent_charged has waited ${Math.round(rentWaited / MINUTE)} min; the account is not billing rent`,
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
    ...(deps.plivo ? numberJobs({ db: deps.db, plivo: deps.plivo, now }, log) : []),
  ];
}

/** Rent, releases, half-done rents, KYC and complaints: everything that talks to Plivo. */
export function numberJobs(
  deps: { db: Database; plivo: Plivo; now: () => Date },
  log: (line: string) => void,
): Job[] {
  return [
    {
      name: "monthly-number-rent",
      everyMs: 60 * MINUTE,
      run: async () => {
        const result = await chargeMonthlyRent(deps);
        if (result.charged > 0) log(`rent: charged ${result.charged} number-month(s)`);
        if (result.released + result.releasePending > 0) {
          log(
            `rent: ${result.released + result.releasePending} number(s) released at renewal: their KYC is no longer accepted`,
          );
        }
      },
    },
    {
      name: "number-releases",
      everyMs: 5 * MINUTE,
      run: async () => {
        const result = await retryPendingReleases(deps);
        if (result.released > 0)
          log(`released ${result.released} number(s) Plivo had not confirmed`);
        if (result.stuck > 0) {
          log(
            `ALERT number-release-stuck: ${result.stuck} number(s) stopped answering but Plivo has not released them for over an hour`,
          );
        }
      },
    },
    {
      name: "abandoned-rents",
      everyMs: 5 * MINUTE,
      run: async () => {
        const result = await undoAbandonedRents(deps);
        if (result.undone > 0)
          log(`undid ${result.undone} rent(s) left half-way; nothing was charged`);
      },
    },
    {
      name: "kyc-poll-pending",
      everyMs: 5 * MINUTE,
      run: async () => logKycPoll(await pollNumberKyc(deps, ["submitted", "suspended"]), log),
    },
    {
      name: "kyc-poll-accepted",
      everyMs: 6 * 60 * MINUTE,
      run: async () => logKycPoll(await pollNumberKyc(deps, ["accepted"]), log),
    },
    {
      name: "ucc-complaints",
      everyMs: 5 * MINUTE,
      run: async () => {
        let result;
        try {
          result = await syncUccComplaints(deps);
        } catch (error) {
          log(
            `ALERT ucc-poll-failed: could not read complaints from Plivo: ${errorMessage(error)}`,
          );
          return;
        }
        if (result.created + result.changed > 0) {
          log(`ucc: ${result.created} new complaint(s), ${result.changed} changed`);
        }
        if (result.unmatched.length > 0) {
          log(
            `ALERT ucc-complaint-unmatched: no org held the calling number for ${result.unmatched.join(", ")}`,
          );
        }
      },
    },
  ];
}

function logKycPoll(result: { changed: number; failed: number }, log: (line: string) => void) {
  if (result.changed > 0) log(`kyc: ${result.changed} org(s) changed status`);
  if (result.failed > 0) {
    log(`ALERT kyc-poll-failed: Plivo did not answer for ${result.failed} org(s)`);
  }
}
