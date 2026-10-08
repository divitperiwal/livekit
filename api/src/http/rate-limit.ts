/**
 * Requests per key per minute, in this process. The api runs as one container in
 * phase 1; a second api container needs this moved to Redis.
 */
export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null when allowed; else the seconds until the window resets. */
  take(key: string): number | null {
    const now = this.now();
    const window = this.#windows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      this.#windows.set(key, { startedAt: now, count: 1 });
      if (this.#windows.size > 10_000) this.#prune(now);
      return null;
    }
    if (window.count >= this.limitPerMinute) {
      return Math.ceil((window.startedAt + 60_000 - now) / 1000);
    }
    window.count += 1;
    return null;
  }

  #prune(now: number) {
    for (const [key, window] of this.#windows)
      if (now - window.startedAt >= 60_000) this.#windows.delete(key);
  }
}
