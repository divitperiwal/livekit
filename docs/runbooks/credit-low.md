# credit-low

**Means:** a postpaid account's unpaid usage crossed 80% of its `credit_cap_inr`. The account was sent `account.credit_low`. At 100% every new call is refused (402).

**Check:** `bun run cli account show <slug>` (unpaid, cap, today's usage).

**Fix:** chase the payment, then `bun run cli account payment --account <slug> --amount <₹> --ref <bank ref>`; calls resume at once. Raising the cap (`account limits <slug> --credit-cap <₹>`) is a commercial decision, not an ops fix.
