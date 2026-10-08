import { describe, expect, test } from "bun:test";
import {
  accountLedger,
  callEvents,
  calls,
  usageRecords,
  webhookDeliveries,
} from "../../src/db/schema";
import { createScenario, event } from "../http/scenario";

describe("guarantee 9: retried writes never double-insert or double-charge", () => {
  test("opening the same job twice gives one call record", async () => {
    const { open, openRequest, db } = await createScenario();
    const request = openRequest();
    const first = await open(request);
    const retry = await open(request);
    expect(retry.body.id).toBe(first.body.id);
    expect(await db.$count(calls)).toBe(1);
  });

  test("a retried event batch inserts only what is new", async () => {
    const { open, appendEvents, db } = await createScenario();
    const { body } = await open();
    await appendEvents(body.id, [event(1), event(2)]);
    expect((await appendEvents(body.id, [event(1), event(2), event(3)])).body).toEqual({
      inserted: 1,
    });
    expect(await db.$count(callEvents)).toBe(3);
  });

  test("a retried finalize returns the first result and charges once", async () => {
    const { open, finalize, db } = await createScenario();
    const { body } = await open();
    const first = await finalize(body.id);
    const retry = await finalize(body.id, { status: "failed", durationSeconds: 999 });
    expect(retry.body).toEqual(first.body);
    expect(await db.$count(usageRecords)).toBe(1);
    expect(await db.$count(accountLedger)).toBe(1);
    expect(await db.$count(webhookDeliveries)).toBe(2);
  });

  test("simultaneous finalizes of one call charge once", async () => {
    const { open, finalize, db } = await createScenario();
    const { body } = await open();
    await Promise.all([finalize(body.id), finalize(body.id), finalize(body.id)]);
    expect(await db.$count(usageRecords)).toBe(1);
    expect(await db.$count(accountLedger)).toBe(1);
  });
});
