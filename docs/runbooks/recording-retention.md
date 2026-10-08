# recording-retention

**Means:** recordings past their org's retention (`recording_retention_days`, default 30) could not be deleted from Spaces. They stay listed on the call and are retried hourly. The bucket's lifecycle rule is the backstop.

**Impact:** recordings kept longer than promised (DPDP).

**Check:** background logs for "could not delete recording" with the error; the `RECORDING_S3_*` key used by background must have delete access (the worker's needs only write).

**Fix:** fix the credentials or permissions; the next hourly pass catches up.
