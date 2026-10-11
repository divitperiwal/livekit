# kyc-requirements-changed

**Means:** a business tried to submit its number KYC and Plivo's Requirements lookup no longer matched what we send: a document type we expect (Registration Certificate, GST Certificate) is gone, or Plivo now requires a field other than `business_name`. The submission was refused with 503 and nothing reached Plivo.

**Check:** the log line names what changed. See Plivo's current list: `GET https://api.plivo.com/v1/Account/<auth_id>/PhoneNumber/Compliance/Requirements?country_iso=IN&number_type=local&user_type=business` with the account's credentials.

**Fix:** update `kycApplication` and `dataFields` in `api/src/modules/numbers/number-kyc.ts` to the new requirements (and the `/v1` and CLI inputs if a new field must come from the business), then deploy. Tell automitra if its form needs the new field.
