# sarvam-rate-limited

**Means:** Sarvam answered HTTP 429 to a worker's speech-to-text, LLM or text-to-speech request (the log line names which, and whether the plugin is retrying or gave up). Logged by the worker, once per failed attempt; the post-call analysis model is watched too.

**Impact:** the caller hears silence while the plugin retries. If it gives up, the turn fails: the agent does not answer, or the call fails over to the agent's fallback provider if it has one. A 429 on the analysis leaves the call without a summary.

**Check:** how many calls were live at the time (`calls` in `ringing` / `in_progress`) against the Sarvam plan's limits (Starter: 40 LLM requests a minute, about 5 concurrent calls). A burst on one worker with few calls points at a single runaway call (a reply loop); many calls at once points at the plan.

**Fix:** upgrade the Sarvam plan. Until then, lower `max_concurrent_calls` (`bun run cli key concurrency <prefix> <n>`) for the keys placing the load; inbound calls hold no key's slot, so they cannot be limited this way. Raise the keys' limits again only after the plan.
