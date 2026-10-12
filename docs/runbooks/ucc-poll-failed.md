# ucc-poll-failed

**Means:** the background job could not read unsolicited-call (UCC) complaints from Plivo (`GET /Ucc/`): Plivo was down, rate limited us, rejected our credentials, or answered with a shape we do not recognise. It runs every 5 minutes and tries again on its own.

**Impact:** new complaints and Plivo's decisions on proof are not recorded or sent to the account (`ucc_complaint.updated`), and complainants are not added to do-not-call lists, until a poll succeeds. The proof deadline is 5 business days, so a few failed polls are harmless; hours of them are not.

**Check:** the error text in the alert. `401`: the Plivo credentials in `deploy/.env`. A parse error: compare Plivo's UCC API reference (https://www.plivo.com/docs/numbers/ucc) with `uccComplaintSchema` in `api/src/modules/numbers/plivo.ts`.

**Fix:** a Plivo outage needs nothing. A changed response shape needs a code fix; meanwhile, read new complaints in Plivo's console (Phone Numbers > UCC) and pass them on to the account by hand.
