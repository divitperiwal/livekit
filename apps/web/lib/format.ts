/**
 * Presenting numbers and times.
 *
 * Rupees are shown to two decimals because a call can cost a few paise and
 * rounding those away makes a usage table look wrong when the rows do not add
 * up to the total.
 */

export function rupees(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const amount = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(amount)) return "—";
  return `₹${amount.toFixed(2)}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function timeOnly(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeStyle: "medium",
  }).format(date);
}

/** A phone number, or a note that it was a browser rather than a phone. */
export function phone(value: string | null | undefined): string {
  return value && value.trim() ? value : "web";
}
