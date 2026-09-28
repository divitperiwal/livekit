/**
 * The rules a campaign runs by.
 *
 * The expensive mistakes here are all quiet ones: a window evaluated in the
 * wrong timezone rings someone at night, a retry rule off by one rings them
 * six times, and a phone number misread as another country's rings a
 * stranger. Each is pinned down below with exact instants.
 */

import { describe, expect, test } from "bun:test";

import {
  afterAttempt,
  CampaignInputError,
  contactsFromCsv,
  contactsFromJson,
  DEFAULT_RETRY_POLICY,
  indiaWindowOpen,
  localTime,
  normalizePhone,
  parseCsv,
  validateRetryPolicy,
  validateSchedule,
  windowOpen,
  type RetryPolicy,
  type Schedule,
} from "./campaign-rules";

// 2026-09-28 is a Monday.
const at = (iso: string) => new Date(iso);

describe("calling windows", () => {
  const weekdays: Schedule = {
    timezone: "Asia/Kolkata",
    windows: [{ days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00" }],
  };

  test("reads the local weekday and time", () => {
    // 04:30 UTC is 10:00 in India.
    expect(localTime(at("2026-09-28T04:30:00Z"), "Asia/Kolkata")).toEqual({ weekday: 1, hhmm: "10:00" });
    // An hour earlier it is Monday morning in India but still Sunday night
    // in New York.
    expect(localTime(at("2026-09-28T03:30:00Z"), "Asia/Kolkata")).toEqual({ weekday: 1, hhmm: "09:00" });
    expect(localTime(at("2026-09-28T03:30:00Z"), "America/New_York")).toEqual({ weekday: 7, hhmm: "23:30" });
  });

  test("open inside the window, in the schedule's timezone", () => {
    expect(windowOpen(weekdays, at("2026-09-28T04:30:00Z"))).toBe(true); // Mon 10:00 IST
    expect(windowOpen(weekdays, at("2026-09-28T13:29:00Z"))).toBe(true); // Mon 18:59 IST
  });

  test("the end is exclusive", () => {
    expect(windowOpen(weekdays, at("2026-09-28T13:30:00Z"))).toBe(false); // Mon 19:00 IST
  });

  test("closed before the start and on days not listed", () => {
    expect(windowOpen(weekdays, at("2026-09-28T04:29:00Z"))).toBe(false); // Mon 09:59 IST
    expect(windowOpen(weekdays, at("2026-09-27T06:00:00Z"))).toBe(false); // Sun 11:30 IST
  });

  test("a UTC-evening instant can be the next morning in India", () => {
    // 2026-09-28T23:00Z is Tuesday 04:30 IST: closed, though it is a weekday
    // evening in UTC.
    expect(windowOpen(weekdays, at("2026-09-28T23:00:00Z"))).toBe(false);
  });

  test("an Indian number has a hard outer bound whatever the schedule says", () => {
    expect(indiaWindowOpen(at("2026-09-28T03:30:00Z"))).toBe(true); // 09:00 IST
    expect(indiaWindowOpen(at("2026-09-28T03:29:00Z"))).toBe(false); // 08:59 IST
    expect(indiaWindowOpen(at("2026-09-28T15:30:00Z"))).toBe(false); // 21:00 IST
  });
});

describe("validating a schedule", () => {
  test("missing means the conservative default", () => {
    expect(validateSchedule(undefined).timezone).toBe("Asia/Kolkata");
  });

  test("rejects a made-up timezone", () => {
    expect(() => validateSchedule({ timezone: "Mars/Olympus", windows: [{ days: [1], start: "10:00", end: "11:00" }] })).toThrow(
      CampaignInputError,
    );
  });

  test("rejects an overnight window rather than calling through the night", () => {
    expect(() =>
      validateSchedule({ timezone: "Asia/Kolkata", windows: [{ days: [1], start: "21:00", end: "09:00" }] }),
    ).toThrow(CampaignInputError);
  });

  test("rejects malformed times and days", () => {
    for (const w of [
      { days: [0], start: "10:00", end: "11:00" },
      { days: [8], start: "10:00", end: "11:00" },
      { days: [1], start: "9:00", end: "11:00" },
      { days: [1], start: "10:00", end: "24:00" },
      { days: [], start: "10:00", end: "11:00" },
    ]) {
      expect(() => validateSchedule({ timezone: "Asia/Kolkata", windows: [w] })).toThrow(CampaignInputError);
    }
  });
});

describe("after an attempt", () => {
  const now = at("2026-09-28T06:00:00Z");
  const policy: RetryPolicy = { maxAttempts: 3, retryAfterMinutes: [30, 120], retryOn: ["no_answer", "busy", "voicemail"] };

  test("a conversation completes the contact", () => {
    expect(afterAttempt(policy, 1, "completed", null, now)).toEqual({ status: "completed", nextAttemptAt: null });
  });

  test("an unanswered call is retried after the first wait", () => {
    const next = afterAttempt(policy, 1, "no_answer", "sip_480", now);
    expect(next.status).toBe("pending");
    expect(next.nextAttemptAt?.toISOString()).toBe("2026-09-28T06:30:00.000Z");
  });

  test("the second retry waits the second interval, and the last one repeats", () => {
    expect(afterAttempt(policy, 2, "busy", null, now).nextAttemptAt?.toISOString()).toBe("2026-09-28T08:00:00.000Z");
    const long: RetryPolicy = { ...policy, maxAttempts: 5 };
    expect(afterAttempt(long, 4, "busy", null, now).nextAttemptAt?.toISOString()).toBe("2026-09-28T08:00:00.000Z");
  });

  test("the last attempt exhausts the contact", () => {
    expect(afterAttempt(policy, 3, "no_answer", null, now)).toEqual({ status: "exhausted", nextAttemptAt: null });
  });

  test("a number that does not exist is never retried", () => {
    const always: RetryPolicy = { ...policy, retryOn: ["failed"] };
    expect(afterAttempt(always, 1, "failed", "sip_404", now).status).toBe("failed");
    // A transient failure is.
    expect(afterAttempt(always, 1, "failed", "sip_503", now).status).toBe("pending");
  });

  test("an outcome the policy does not retry is final", () => {
    expect(afterAttempt(policy, 1, "failed", "dial_error", now).status).toBe("failed");
    const noVoicemail: RetryPolicy = { ...policy, retryOn: ["no_answer"] };
    expect(afterAttempt(noVoicemail, 1, "voicemail", "amd_machine-vm", now).status).toBe("completed");
  });
});

describe("validating a retry policy", () => {
  test("missing means the default", () => {
    expect(validateRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY);
  });

  test("refuses redialling within five minutes", () => {
    expect(() => validateRetryPolicy({ retryAfterMinutes: [1] })).toThrow(CampaignInputError);
  });

  test("refuses unbounded attempts and unknown outcomes", () => {
    expect(() => validateRetryPolicy({ maxAttempts: 50 })).toThrow(CampaignInputError);
    expect(() => validateRetryPolicy({ retryOn: ["completed"] })).toThrow(CampaignInputError);
  });
});

describe("phone numbers", () => {
  test("Indian numbers without a country code", () => {
    expect(normalizePhone("98765 43210")).toBe("+919876543210");
    expect(normalizePhone("098765-43210")).toBe("+919876543210");
    expect(normalizePhone("919876543210")).toBe("+919876543210");
    expect(normalizePhone("(987) 654-3210")).toBe("+919876543210");
  });

  test("international numbers must say so", () => {
    expect(normalizePhone("+1 415 555 0100")).toBe("+14155550100");
    expect(normalizePhone("0044 20 7946 0000")).toBe("+442079460000");
  });

  test("anything else is not a number", () => {
    for (const raw of ["", "abc", "12345", "+0123456789", "98765432101234", "0000000000"]) {
      expect(normalizePhone(raw)).toBeNull();
    }
  });
});

describe("contact lists", () => {
  test("CSV with quotes, commas and blank lines", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["1", "2"],
    ]);
  });

  test("the phone column is found by name and the rest become variables", () => {
    const { contacts, rejected } = contactsFromCsv(
      "First Name,Mobile Number,Amount Due\nAsha,9876543210,1200\nRavi,not-a-number,50\n",
    );
    expect(contacts).toEqual([
      { e164: "+919876543210", variables: { first_name: "Asha", amount_due: "1200" } },
    ]);
    expect(rejected).toEqual([{ row: 3, value: "not-a-number", reason: "not a phone number" }]);
  });

  test("without a recognisable header the first column is the phone", () => {
    const { contacts } = contactsFromCsv("who,name\n9876543210,Asha");
    expect(contacts[0]?.e164).toBe("+919876543210");
  });

  test("JSON contacts", () => {
    const { contacts, rejected } = contactsFromJson([
      { phone: "+919876543210", variables: { name: "Asha", amount: 1200 } },
      { phone: "nope" },
    ]);
    expect(contacts).toEqual([{ e164: "+919876543210", variables: { name: "Asha", amount: "1200" } }]);
    expect(rejected).toHaveLength(1);
  });
});
