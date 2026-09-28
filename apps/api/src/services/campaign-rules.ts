/**
 * The rules a campaign runs by, as pure functions.
 *
 * When a number may be called, what happens after each attempt, and what
 * counts as a number at all. Kept free of the database so each rule can be
 * tested exactly, including the ones -- calling windows across timezones,
 * retry backoff -- that are easy to get subtly wrong and expensive to get
 * wrong in production, where the symptom is someone's phone ringing at night
 * or ringing six times.
 */

export type RetryableStatus = "no_answer" | "busy" | "failed" | "voicemail";

export interface CallingWindow {
  /** ISO weekdays: 1 is Monday, 7 is Sunday. */
  days: number[];
  /** "HH:MM", 24-hour, in the schedule's timezone. */
  start: string;
  end: string;
}

export interface Schedule {
  timezone: string;
  windows: CallingWindow[];
}

export interface RetryPolicy {
  /** Attempts in all, including the first. */
  maxAttempts: number;
  /**
   * Minutes to wait before each retry: the first entry after the first
   * attempt, and so on, with the last entry repeating.
   */
  retryAfterMinutes: number[];
  /** Which outcomes are worth another attempt. */
  retryOn: RetryableStatus[];
}

/** Monday to Saturday, ten to seven, India time: a conservative default. */
export const DEFAULT_SCHEDULE: Schedule = {
  timezone: "Asia/Kolkata",
  windows: [{ days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" }],
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  retryAfterMinutes: [60, 240],
  retryOn: ["no_answer", "busy", "failed", "voicemail"],
};

/**
 * The outer bound on calling an Indian number, whatever a schedule says.
 *
 * TRAI restricts commercial calls to daytime hours. A campaign's own schedule
 * can narrow this but never widen it, so a timezone typo or a window typed as
 * "21:00-09:00" cannot put a call through to someone at midnight. Check the
 * current regulations for your category of call: this is a ceiling the
 * platform enforces, not legal advice about where yours should be.
 */
export const INDIA_WINDOW = { timezone: "Asia/Kolkata", start: "09:00", end: "21:00" };

/**
 * SIP responses meaning the number itself is wrong. Retrying reaches the same
 * "this number does not exist" recording and costs money each time.
 */
export const UNREACHABLE_REASONS = new Set(["sip_404", "sip_410", "sip_484", "sip_604"]);

export const MAX_CONCURRENCY = Number(process.env.DIALER_MAX_CONCURRENCY ?? 50);
const MAX_ATTEMPTS = 10;
const MAX_WINDOWS = 14;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

export class CampaignInputError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(
      Object.entries(fieldErrors)
        .map(([field, message]) => `${field} ${message}`)
        .join("; "),
    );
    this.name = "CampaignInputError";
  }
}

export function isTimezone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function validateSchedule(raw: unknown): Schedule {
  if (raw === undefined || raw === null) return DEFAULT_SCHEDULE;
  const errors: Record<string, string> = {};
  const input = raw as Partial<Schedule>;

  if (!isTimezone(input.timezone)) errors["schedule.timezone"] = "is not a known IANA timezone";
  if (!Array.isArray(input.windows) || input.windows.length === 0) {
    errors["schedule.windows"] = "must list at least one calling window";
  } else if (input.windows.length > MAX_WINDOWS) {
    errors["schedule.windows"] = `may list at most ${MAX_WINDOWS} windows`;
  } else {
    input.windows.forEach((w, i) => {
      const days = (w as CallingWindow)?.days;
      if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
        errors[`schedule.windows.${i}.days`] = "must be weekdays from 1 (Monday) to 7 (Sunday)";
      }
      const { start, end } = (w ?? {}) as CallingWindow;
      if (typeof start !== "string" || !HHMM.test(start)) errors[`schedule.windows.${i}.start`] = 'must be "HH:MM"';
      if (typeof end !== "string" || !HHMM.test(end)) errors[`schedule.windows.${i}.end`] = 'must be "HH:MM"';
      if (typeof start === "string" && typeof end === "string" && HHMM.test(start) && HHMM.test(end) && start >= end) {
        // Overnight windows are refused rather than supported: calling
        // through the night is never what a campaign should be doing.
        errors[`schedule.windows.${i}`] = "must start before it ends, within one day";
      }
    });
  }

  if (Object.keys(errors).length > 0) throw new CampaignInputError(errors);
  return {
    timezone: input.timezone as string,
    windows: (input.windows as CallingWindow[]).map(({ days, start, end }) => ({
      days: [...new Set(days)].sort(),
      start,
      end,
    })),
  };
}

export function validateRetryPolicy(raw: unknown): RetryPolicy {
  if (raw === undefined || raw === null) return DEFAULT_RETRY_POLICY;
  const input = { ...DEFAULT_RETRY_POLICY, ...(raw as Partial<RetryPolicy>) };
  const errors: Record<string, string> = {};

  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS) {
    errors["retryPolicy.maxAttempts"] = `must be a whole number from 1 to ${MAX_ATTEMPTS}`;
  }
  if (
    !Array.isArray(input.retryAfterMinutes) ||
    input.retryAfterMinutes.length === 0 ||
    !input.retryAfterMinutes.every((m) => typeof m === "number" && m >= 5 && m <= 7 * 24 * 60)
  ) {
    // At least five minutes: redialling someone who just declined is how a
    // number gets reported as spam.
    errors["retryPolicy.retryAfterMinutes"] = "must list waits of 5 minutes to 7 days";
  }
  const retryable: RetryableStatus[] = ["no_answer", "busy", "failed", "voicemail"];
  if (!Array.isArray(input.retryOn) || !input.retryOn.every((s) => retryable.includes(s))) {
    errors["retryPolicy.retryOn"] = `may only contain: ${retryable.join(", ")}`;
  }

  if (Object.keys(errors).length > 0) throw new CampaignInputError(errors);
  return {
    maxAttempts: input.maxAttempts,
    retryAfterMinutes: input.retryAfterMinutes,
    retryOn: [...new Set(input.retryOn)],
  };
}

export function validateConcurrency(raw: unknown): number {
  if (raw === undefined || raw === null) return 5;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CONCURRENCY) {
    throw new CampaignInputError({ concurrency: `must be a whole number from 1 to ${MAX_CONCURRENCY}` });
  }
  return raw;
}

// --- time ---------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The weekday and "HH:MM" it is right now somewhere. */
export function localTime(now: Date, timezone: string): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: WEEKDAYS[get("weekday")] ?? 0, hhmm: `${get("hour")}:${get("minute")}` };
}

/** Whether any of the schedule's windows is open at `now`. End is exclusive. */
export function windowOpen(schedule: Schedule, now: Date): boolean {
  const { weekday, hhmm } = localTime(now, schedule.timezone);
  return schedule.windows.some((w) => w.days.includes(weekday) && w.start <= hhmm && hhmm < w.end);
}

/** Whether an Indian number may be called at all right now. */
export function indiaWindowOpen(now: Date): boolean {
  const { hhmm } = localTime(now, INDIA_WINDOW.timezone);
  return INDIA_WINDOW.start <= hhmm && hhmm < INDIA_WINDOW.end;
}

// --- after an attempt ---------------------------------------------------------

export interface Transition {
  status: "pending" | "completed" | "failed" | "exhausted";
  nextAttemptAt: Date | null;
}

/**
 * What happens to a contact once an attempt has ended.
 *
 * `attempts` counts the attempt that just finished. `callStatus` is the call
 * record's status; `endReason` refines it, since a failure because the
 * number does not exist is not worth repeating and a failure because the
 * carrier hiccuped is.
 */
export function afterAttempt(
  policy: RetryPolicy,
  attempts: number,
  callStatus: string,
  endReason: string | null,
  now: Date,
): Transition {
  if (callStatus === "completed") return { status: "completed", nextAttemptAt: null };

  if (callStatus === "failed" && endReason && UNREACHABLE_REASONS.has(endReason)) {
    return { status: "failed", nextAttemptAt: null };
  }

  const retryable = (policy.retryOn as string[]).includes(callStatus);
  if (retryable && attempts < policy.maxAttempts) {
    const waits = policy.retryAfterMinutes;
    const minutes = waits[Math.min(attempts - 1, waits.length - 1)] ?? 60;
    return { status: "pending", nextAttemptAt: new Date(now.getTime() + minutes * 60_000) };
  }

  if (retryable) return { status: "exhausted", nextAttemptAt: null };
  // Not worth retrying by this campaign's own policy. A voicemail that was
  // not to be retried has been dealt with; anything else simply failed.
  return { status: callStatus === "voicemail" ? "completed" : "failed", nextAttemptAt: null };
}

// --- contact lists ------------------------------------------------------------

/**
 * A phone number in E.164, or null.
 *
 * A number without a country code is read as Indian: ten digits, or eleven
 * with the trunk-prefix zero, or twelve starting 91. Anything else has to
 * carry its own "+" -- guessing the country of a foreign number is how the
 * wrong person gets called.
 */
export function normalizePhone(raw: string): string | null {
  let s = raw.trim().replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) return E164.test(s) ? s : null;
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 10 && /^[1-9]/.test(s)) return `+91${s}`;
  if (s.length === 11 && s.startsWith("0")) return normalizePhone(s.slice(1));
  if (s.length === 12 && s.startsWith("91")) return normalizePhone(s.slice(2));
  return null;
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines carry nothing.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface ContactRow {
  e164: string;
  variables: Record<string, string>;
}

export interface RejectedRow {
  row: number;
  value: string;
  reason: string;
}

const PHONE_HEADERS = /^(phone|phone_?number|mobile|mobile_?number|number|e164|contact|msisdn)$/i;

/** A header as a variable name: "First Name" becomes first_name. */
function variableName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Reads a contact list from CSV.
 *
 * The first row names the columns. The phone column is whichever header
 * looks like one, or the first column; every other column becomes a variable
 * the prompt can use, so a column headed "First Name" is `{{first_name}}`.
 */
export function contactsFromCsv(text: string): { contacts: ContactRow[]; rejected: RejectedRow[] } {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header) return { contacts: [], rejected: [] };

  const names = header.map(variableName);
  let phoneColumn = header.findIndex((h) => PHONE_HEADERS.test(variableName(h)));
  if (phoneColumn < 0) phoneColumn = 0;

  const contacts: ContactRow[] = [];
  const rejected: RejectedRow[] = [];
  body.forEach((cells, index) => {
    const raw = cells[phoneColumn] ?? "";
    const e164 = normalizePhone(raw);
    if (!e164) {
      // Row numbers as a spreadsheet shows them: the header is row 1.
      rejected.push({ row: index + 2, value: raw, reason: "not a phone number" });
      return;
    }
    const variables: Record<string, string> = {};
    cells.forEach((cell, column) => {
      const name = names[column];
      if (column !== phoneColumn && name && cell.trim() !== "") variables[name] = cell.trim();
    });
    contacts.push({ e164, variables });
  });
  return { contacts, rejected };
}

/** Reads a contact list sent as JSON: `[{ phone, variables }]`. */
export function contactsFromJson(items: unknown): { contacts: ContactRow[]; rejected: RejectedRow[] } {
  const contacts: ContactRow[] = [];
  const rejected: RejectedRow[] = [];
  if (!Array.isArray(items)) return { contacts, rejected: [{ row: 0, value: "", reason: "contacts must be a list" }] };

  items.forEach((item, index) => {
    const phone = (item as { phone?: unknown })?.phone;
    const e164 = typeof phone === "string" ? normalizePhone(phone) : null;
    if (!e164) {
      rejected.push({ row: index + 1, value: String(phone ?? ""), reason: "not a phone number" });
      return;
    }
    const variables: Record<string, string> = {};
    const raw = (item as { variables?: unknown }).variables;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (value !== null && value !== undefined) variables[key] = String(value);
      }
    }
    contacts.push({ e164, variables });
  });
  return { contacts, rejected };
}
