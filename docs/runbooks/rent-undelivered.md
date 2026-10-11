# rent-undelivered

**Means:** a `number.rent_charged` webhook has waited more than 15 minutes. The account bills its businesses for number rent from these, so their invoices are going stale. Like `usage.recorded`, they are retried forever (every 12 h at the slowest) and never marked failed.

**Check:** `select e.url, d.attempts, d.last_status_code, d.last_error, d.next_attempt_at from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.event = 'number.rent_charged' and d.status = 'pending' order by d.created_at limit 20;` Also check the background container is running (`docker compose ps background`). An endpoint not subscribed to `number.rent_charged` gets no rows at all: `bun src/cli.ts webhook list --account <slug>`.

**Fix:** once the endpoint is back, bring the rows forward: `update webhook_deliveries set next_attempt_at = now() where event = 'number.rent_charged' and status = 'pending';`. Charges are idempotent on `numberRentId`, so a repeat never bills twice.
