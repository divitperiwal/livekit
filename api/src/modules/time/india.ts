/** India has one time zone and no daylight saving: IST is always UTC+05:30. */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** Midnight IST that starts the day containing `at`. */
export function startOfIndianDay(at: Date): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/** Midnight IST on the 1st of the month containing `at`. */
export function startOfIndianMonth(at: Date): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/** Minutes since midnight IST, 0–1439. */
export function indianMinuteOfDay(at: Date): number {
  return (at.getTime() - startOfIndianDay(at).getTime()) / 60_000;
}

/**
 * The same IST date and time `months` calendar months later, clamped to the month's last
 * day (31 Jan + 1 month = 28 or 29 Feb). Count each period from the same start, never
 * from the previous result, or the day drifts after a short month.
 */
export function addIndianMonths(at: Date, months: number): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}
