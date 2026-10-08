# lost-dispatch

**Means:** a call placed through `POST /v1/.../calls` stayed `queued` for 5 minutes: LiveKit accepted (or we thought it accepted) the dispatch, but no worker opened the call. The sweep marked it `failed` (`dispatch_lost`) to free the key's concurrency slot. Nothing was dialled or billed.

**Check:** are both worker containers up and registered (`docker compose ps`, worker logs for "registered worker")? Does `TELEPHONY_AGENT_NAME` on the api match the worker's? LiveKit Cloud status.

**Fix:** restart a stuck worker (one at a time; never both). The client sees the call as `failed` with `endReason: dispatch_lost` and may place it again.
