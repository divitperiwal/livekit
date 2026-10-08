# webhook-delivery-failed

**Means:** a `call.ended` or `account.credit_low` delivery failed every retry (1 m, 5 m, 30 m, 2 h, 6 h, 12 h) and was marked failed. (`usage.recorded` never fails; see usage-undelivered.)

**Check:** `select e.url, d.event, d.event_key, d.last_status_code, d.last_error from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.status = 'failed' order by d.created_at desc limit 20;`

**Fix:** once the endpoint works, re-queue: `update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now() where status = 'failed' and endpoint_id = '<id>';`. If an endpoint is gone for good, `bun run cli webhook disable --account <slug> <id>` keeps new events queued without retry noise.
