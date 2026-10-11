# number-release-stuck

**Means:** a number has been `releasing` for over an hour. It stopped answering (no agent) when the release began, but Plivo has not confirmed it gave the number back, so we may still be paying Plivo for it. The `number-releases` job retries every 5 minutes.

**Check:** `select e164, org_id, source, updated_at from phone_numbers where status = 'releasing' order by updated_at;` Then the background logs for the Plivo error: `docker compose logs background | grep -i plivo`. In Plivo's console (Phone Numbers), see whether the number is still on the account.

**Fix:** if Plivo is down, wait; the job keeps trying. If the console shows the number already gone, the next pass marks it released (Plivo answers 404, which counts as released). If Plivo keeps refusing, release it by hand in the console; the job then finishes on its next pass and sends `number.released`.
