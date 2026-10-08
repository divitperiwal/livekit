# lost-worker

**Means:** a call was still ringing or in progress past `TELEPHONY_MAX_CALL_SECONDS` + 5 minutes without being finalized: its worker process died or lost the API. The sweep marked it `failed` (`worker_lost`) to free its slot, but left it unfinalized, so if the worker's finalize arrives late it is still recorded and billed.

**Check:** worker logs around the call's `lk_room_name` (crash, OOM kill, a deploy that did not wait `stop_grace_period`).

**Fix:** if a deploy caused it, check `stop_grace_period` ≥ `TELEPHONY_MAX_CALL_SECONDS` + 3 min and that workers are deployed one at a time. The call's usage is lost unless the worker reports it; decide case by case whether to bill by hand (`account adjust`).
