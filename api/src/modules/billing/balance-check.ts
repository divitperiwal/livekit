import { errorMessage } from "../../error-message";
import { z } from "zod";

const balanceResponseSchema = z.object({ availableInr: z.number() });

export const BALANCE_CHECK_TIMEOUT_MS = 1_000;
export const BALANCE_CACHE_MS = 30_000;

export type BalanceCheckTarget = {
  accountId: string;
  url: string;
  bearerSecret: string;
  orgExternalId: string;
};

export type BalanceCheckDependencies = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Called when the account's URL does not answer usefully; the call is allowed anyway. */
  onFailure?: (target: BalanceCheckTarget, reason: string) => void;
};

/**
 * Asks the account what one of its orgs can spend: `GET {url}?orgId=<externalId>` with a
 * bearer secret, answering `{ availableInr }`. 1 s timeout; answers cached 30 s per org.
 * Fails open: no usable answer returns null, meaning no limit from the account.
 */
export class BalanceChecker {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #onFailure: NonNullable<BalanceCheckDependencies["onFailure"]>;
  readonly #cache = new Map<string, { availableInr: number; expiresAt: number }>();

  constructor({
    fetch: fetchImpl = fetch,
    now = Date.now,
    onFailure,
  }: BalanceCheckDependencies = {}) {
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#onFailure =
      onFailure ??
      ((target, reason) =>
        console.warn(
          `ALERT balance-check-failed-open: account ${target.accountId}, org ${target.orgExternalId}: ${reason}; the call was allowed`,
        ));
  }

  async availableInr(target: BalanceCheckTarget): Promise<number | null> {
    const cacheKey = `${target.accountId}:${target.orgExternalId}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.availableInr;

    const url = new URL(target.url);
    url.searchParams.set("orgId", target.orgExternalId);
    // An explicit timer: Bun's AbortSignal.timeout does not fire while the loop is otherwise idle.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`no answer within ${BALANCE_CHECK_TIMEOUT_MS} ms`)),
      BALANCE_CHECK_TIMEOUT_MS,
    );
    try {
      const response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${target.bearerSecret}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.#onFailure(target, `HTTP ${response.status}`);
        return null;
      }
      const parsed = balanceResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        this.#onFailure(target, "unexpected body");
        return null;
      }
      this.#cache.set(cacheKey, {
        availableInr: parsed.data.availableInr,
        expiresAt: this.#now() + BALANCE_CACHE_MS,
      });
      return parsed.data.availableInr;
    } catch (error) {
      this.#onFailure(target, errorMessage(error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
