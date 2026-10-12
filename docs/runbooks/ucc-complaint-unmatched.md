# ucc-complaint-unmatched

**Means:** Plivo passed on an unsolicited-call (UCC) complaint about a call from a number no org held on the day of the call (no `phone_numbers` row for that number, assigned to an org and not released before that day). The complaint is stored in `ucc_complaints` with `org_id` null. Nobody was told, and the complainant was put on no do-not-call list.

**Impact:** the proof deadline (5 business days from the complaint) runs regardless. An unanswered complaint blocks the calling number's KYC application for 15 days; five in ten days suspend it.

**Check:** `select reference_id, from_number, complainant_number, called_on from ucc_complaints where org_id is null;` then look the number up: `bun run cli number list`, and in Plivo's console (Phone Numbers > UCC) for the call.

**Fix:** if the number belongs to an org (added by hand in Plivo, never recorded here), set `org_id` on the complaint row, add the complainant to that org's `suppressed_numbers` (source `complaint`) and tell the account to send proof through `/v1`. If the call was not ours, answer the complaint in Plivo's console.
