# usage-undelivered

**Means:** a `usage.recorded` webhook has waited more than 15 minutes. The account debits its customers' wallets from these, so their balances are going stale. These are retried forever (every 12 h at the slowest) and never marked failed.

**Check:** `select e.url, d.attempts, d.last_status_code, d.last_error, d.next_attempt_at from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.event = 'usage.recorded' and d.status = 'pending' order by d.created_at limit 20;` A `last_error` of "non-public address" means the endpoint's DNS points somewhere the SSRF guard blocks. Also check the background container is running (`docker compose ps background`).

**Fix:** if the account's endpoint was down and is back, bring the rows forward instead of waiting for the next retry: `update webhook_deliveries set next_attempt_at = now() where event = 'usage.recorded' and status = 'pending';`. The account can also poll `GET /v1/orgs/:externalId/calls/:id`; debits are idempotent on `usageRecordId`.
