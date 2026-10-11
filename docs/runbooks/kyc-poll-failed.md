# kyc-poll-failed

**Means:** reading a business's KYC status from Plivo failed. The poll is how a suspension or an expiry is noticed (Plivo's callbacks name only accepted and rejected), and how a decision is picked up when a callback is lost.

**Check:** `docker compose logs background | grep -i -e kyc -e plivo` for the error. A 401 means `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` are wrong or rotated; a 404 means the application id stored on the org is unknown to Plivo: `select external_id, number_kyc_status, number_kyc_application_id from orgs where number_kyc_status in ('submitted', 'suspended', 'accepted') and deleted_at is null;`

**Fix:** fix the credentials and restart the background container (`docker compose up -d background`). For one org, `bun src/cli.ts org kyc status --account <slug> --org <id>` reads and stores its status now.
