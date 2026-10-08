# balance-check-failed-open

**Means:** an account's `balance_check_url` did not answer within 1 s, answered non-2xx, or sent a body without `availableInr`. The call was **allowed** (fail open), with no wallet limit on its budget.

**Impact:** calls run without the account's wallet check, so an org with an empty wallet can still talk. Our own credit cap and daily cap still apply.

**Check:** the log line names the account and org. `curl -H "Authorization: Bearer <secret>" "<url>?orgId=<externalId>"` from the api host. If every call alerts, the account's endpoint is down; if one org, it is that org's data.

**Fix:** tell the account (automitra) their balance endpoint is failing. If it will be down for long and the risk is not acceptable, `bun run cli account limits <slug> --daily-cap <₹>` bounds the exposure until it is back.
