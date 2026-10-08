/**
 * Masks personal data in free text before it is written, for orgs with `redact_pii`
 * (guarantee 19). Deliberately broad: any run of six or more digits (phone, Aadhaar,
 * card, account, PIN code; any script's digits, spaces and dashes allowed between),
 * email addresses and PAN numbers. Structured columns the product needs (the call's own
 * from / to numbers, the do-not-call list) are not free text and are kept.
 */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const DIGIT_RUN = /\+?\p{Nd}(?:[\s-]?\p{Nd}){5,}/gu;

export function redactText(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PAN, "[pan]").replace(DIGIT_RUN, "[number]");
}

/** Every string inside a JSON value, masked; keys and structure kept. */
export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item)]),
    ) as T;
  }
  return value;
}
