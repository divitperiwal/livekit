# automitra

A voice AI platform, built on [LiveKit Agents](https://docs.livekit.io/agents/)
with Sarvam for speech, language and voice, and Plivo for the phone network.

## Layout

```
worker/            Python. The LiveKit agent: it runs the live call and nothing else.
apps/api/          Bun. The control plane -- data, auth, billing, provisioning.
apps/web/          Next.js dashboard.
packages/shared/   Generated artefacts both sides depend on.
```

The worker holds no database credentials and owns no schema. It asks the API
which agent a call should run as, and posts transcripts and usage back. Keeping
the boundary there is what lets one worker fleet serve every tenant.

## How a call finds its tenant

One worker fleet serves everyone, registered under a single agent name. That
name is a routing label for the pool, not a tenant identity -- which tenant a
call belongs to arrives per job:

```
metadata on the job  ->  agent version  ->  config      (provisioned numbers, outbound)
dialled number       ->  agent          ->  config      (fallback, one extra lookup)
```

Resolution happens before the room is joined, so it overlaps with WebRTC and
SIP media setup rather than adding to the silence before the agent speaks.

## What a call leaves behind

While a call runs, each finished turn, tool call, error and budget stage change
is buffered and flushed to the control plane every couple of seconds, so a call
can be watched as it happens.

The buffering matters more than it sounds. Session event handlers run on the
loop carrying audio, so nothing on that path does I/O: `add` appends to a list
and returns. The buffer is bounded, and past the cap the oldest events are
dropped with a warning rather than growing until the process runs out of
memory -- a transcript is worth a lot, but not a dropped call.

Turns come from `conversation_item_added`, which fires once per finished turn,
rather than `user_input_transcribed`, which fires repeatedly as speech is
recognised and would store the same sentence several times over in
progressively more complete forms.

The worker assigns each event's sequence number, so a flush retried after a
network failure carries the same numbers and inserts nothing the second time.

**A call that cannot be resolved is ended, not answered.** There is no safe
default: answering with whatever configuration is at hand would put a caller
through to a different company's script, and neither of them would know. With
no `INTERNAL_API_SECRET` set the worker skips all of this and uses environment
configuration, which is what `agent console` and local development do.

## The database

```bash
docker compose up -d              # postgres and redis
cd apps/api && bun install
bun run db:migrate
bun run db:seed                   # KBS Motors as the first tenant
```

See [apps/api/README.md](apps/api/README.md) for the schema and what it is
built around.

## The dashboard

```bash
cd apps/api && bun run dev     # the control plane, :3000
cd apps/web && bun run dev     # the dashboard
```

Sign in as `owner@kbsmotors.test` with the password `db:seed` printed. The
screens: calls with their transcripts, analysis and recordings; analytics; agents (with test suites and experiments), tools,
knowledge, campaigns, numbers, the do-not-call list, usage, and settings
(recording, API keys, webhooks). See [apps/web/README.md](apps/web/README.md).

## What an agent can do on a call

**Tools.** A tool is a customer's HTTP endpoint, saved in the dashboard and
attached to an agent version. The model sees its JSON Schema; when it calls
it, the worker sends the arguments to the URL (as JSON, or as the query string
for `GET`) and gives the model the response, optionally cut down by a
`{{path}}` template. Credentials (bearer, API-key header or HMAC signature) are
encrypted at rest with `SECRETS_KEY`. Only the worker receives them
decrypted, and never through the cache. Every request goes through the SSRF
guard in `ssrf.py`: the address is checked and then pinned for the
connection, and redirects are not followed. A tool that runs past 1.5 seconds
(or one marked slow) makes the agent say it is checking, so the caller doesn't
sit in silence.

**Variables.** `{{name}}` in a prompt, greeting or voicemail message is filled
from the call's variables, which for a campaign are the contact's CSV columns.
`{{name|there}}` gives a fallback. A missing value renders as nothing, never
as braces read aloud.

**Ending and transferring.** The agent gets an `end_call` tool, so it can
hang up after the goodbye instead of holding the line open. Its
`do_not_call` flag adds the caller to the organisation's do-not-call list.
With transfer targets configured it also gets `transfer_call`, a cold
transfer by SIP REFER. **The carrier trunk must allow transfers**, and
minutes after the handoff are the carrier's, not billed to the call. When the
agent's session closes for any reason, the room is deleted, which hangs up
the phone leg.

## Outbound campaigns

A campaign is an agent, a caller ID, a list of contacts, calling hours and a
retry policy. The dialer runs in the background process, alongside webhook
delivery and recording retention:

```bash
cd apps/api && bun run background
```

Every few seconds it moves finished attempts on, and dispatches the agent
for each running campaign whose window is open, up to its concurrency. Each
finished attempt ends as completed, a retry after a wait, or exhausted.
**The worker places the call itself.** It dials with `wait_until_answered`,
so busy, declined and unanswered calls come back as distinct outcomes.
LiveKit's answering-machine detector listens from the first word. A machine
is hung up on, or left a message, per the agent's settings. The greeting is
held until the detector decides.

Some guarantees, each covered by a test in `apps/api/src/services/dialer.test.ts`:

- Never more calls in flight than the campaign's concurrency, even with two
  dialers running. Claiming holds a per-campaign advisory lock.
- The do-not-call list is checked when a contact is dialled, not only when
  the list is uploaded.
- Indian numbers are never called outside 09:00–21:00 India time, whatever the
  campaign's own schedule says. Check the current TRAI rules for your category
  of call; this is the platform's ceiling, not legal advice.
- A dispatch that never becomes a call is counted as a failed attempt after
  five minutes, instead of holding a slot forever. A dispatch LiveKit refuses
  outright is handed back without using an attempt.
- A number that doesn't exist (SIP 404/410/484/604) is not retried.

The national DND registry is **not** checked. Only the organisation's own
list is.

## After the call

**Analysis.** When an answered call ends, the worker asks the same Sarvam
model for a summary, one of the agent's dispositions, and the fields the
agent defines, such as `callback_time` or `budget`. It runs in the job's
`on_session_end` hook: the line is hung up first, so nobody waits for it, and
it finishes before the call is finalised. The result and its tokens go out
with the call and are billed with it. The model's answer is treated as
untrusted: a disposition the agent didn't define, or a value of the wrong
type, is dropped rather than stored.

**Recording.** Off until an organisation turns it on in Settings. The worker
then starts LiveKit Egress once the call is answered, mixed audio to one OGG
file in an S3-compatible bucket (`RECORDING_S3_*`, set on both the worker and
the API). The greeting tells the caller the call is recorded. Only the object
key is stored. The dashboard signs a playback link that lasts ten minutes, and
the background process deletes recordings past the organisation's retention.

**Webhooks.** `call.ended` (the call, its analysis and transcript) and
`campaign.completed`. Events are queued in the same transaction as the
change they report, then delivered by the background process. Each is
signed like tool calls:

```
X-Automitra-Timestamp: <unix seconds>
X-Automitra-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">
X-Automitra-Event-Id:  call.ended:<call id>   (dedupe on this; delivery is at least once)
```

A failing endpoint is retried after 1m, 5m, 30m, 2h, 6h and 12h, then given
up on. Webhook URLs go through the same SSRF defence as tools. It's
reimplemented for the control plane in `safe-fetch.ts`: the address is checked,
then pinned for the connection, and TLS still verifies the hostname.

**Public API.** `/v1`, with an API key from Settings (`Authorization: Bearer
am_live_…`), scoped to one organisation and to `calls:read`, `calls:write`,
`campaigns:read` or `campaigns:write`:

| | |
| --- | --- |
| `POST /v1/calls` | `{ agentId, to, variables?, fromNumberId? }` → `202 { requestId }`. The agent is dispatched to dial; the same checks as a campaign apply (do-not-call, Indian calling hours, credit). |
| `GET /v1/calls?requestId=&disposition=&campaignId=&before=` | Calls, newest first, in the webhook's shape |
| `GET /v1/calls/:id` | One call with its transcript |
| `GET /v1/campaigns/:id`, `GET /v1/campaigns/:id/contacts` | Progress |
| `POST /v1/campaigns/:id/contacts` | `{ contacts: [{ phone, variables }] }` |
| `POST /v1/campaigns/:id/start` / `pause` / `resume` / `cancel` | |

Rate-limited per key (`PUBLIC_API_RATE_PER_MIN`, default 300).

**Knowledge.** Reference documents, pasted, uploaded as text or fetched from
a URL once, are split into passages. Agents they're attached to get a
`search_knowledge` tool. Retrieval is Postgres full-text search with the
`simple` configuration. It needs no embedding provider, and doesn't stem, which
suits Hindi and Hinglish better than an English stemmer would. The trade-off is
that it matches words, not meaning: a question phrased entirely differently
from the document can miss. Passages reach the model marked as quotations, not
instructions.

**Integrations** with specific CRMs are not built. Webhooks push every call's
outcome to any system that accepts HTTP, and tools let the agent read from and
write to one mid-call. A named connector (LeadSquared, HubSpot, Zoho) is a
thin layer over those two.

## Keeping agents good

**Test suites.** A scenario describes a caller (who they are, what they want,
how they talk) and what the agent must do. A run plays every scenario against
a version in text: the model plays the caller, the agent uses its real prompt
and model, and a judge scores each requirement pass or fail. Tools are never
called. Each answers with the scenario's canned response, so testing a
booking agent books nothing. Runs are dispatched to the worker fleet from the
dashboard, or run locally:

```bash
uv run evals <run id>     # against CONTROL_PLANE_URL
```

**Experiments.** Send a share of an agent's calls (1–99%) to another
version. The split is decided per call, after the cache. Both versions keep
their own call records, and Analytics compares them on the same measures.

**Analytics.** Answer rate, dispositions, how calls ended, calls per day, and
per-version outcomes, latency and QA pass rate, for any period and agent.

**Latency.** Every reply's wait is measured from the SDK's metrics: end of
turn, then the model's first token, then the voice's first audio. Each call
records the median, 95th percentile and worst, and which component the time
went to.

**QA scoring.** An agent can list what a good call looks like, for example
"confirmed the appointment time". Each call is scored on those criteria with
the post-call analysis.

**Failover.** Optional LiveKit Inference models for speech-to-text, the LLM
and the voice. They take over mid-call when Sarvam errors or times out. They
only work on LiveKit Cloud and are billed there. A voice failover changes the
voice, and usage from a fallback model is recorded under the configured Sarvam
model names, so a call that failed over is costed at Sarvam's rates.

**Silence and the keypad.** After `silenceTimeout` seconds of silence on both
sides, the agent checks the caller is still there. After `silenceChecks`
unanswered checks it says goodbye and hangs up. Keys the caller presses reach
the agent as `[keypad: 1 2]`. On calls the worker places, the agent can also
press keys itself, to get through a phone menu.

## Team and privacy

**Team.** Owners and admins invite people by link (valid a week, usable
once) and set roles. Membership is checked on every request, so a removed
member loses access at once instead of when their session expires. An
organisation always keeps at least one owner.

**Redaction.** An organisation can have phone numbers, emails, card numbers
(Luhn-checked), Aadhaar and PAN masked in transcripts and summaries as they
are written, so the unmasked text is never stored. Numbers spoken as words
("nine eight seven…") are not caught. Structured analysis fields are kept as
the business asked for them.

**Erasure.** Settings → Privacy erases one person by phone number. Their
calls are anonymised rather than deleted: numbers, transcript, analysis,
variables and recording are removed, and the call's billing record is kept.
Campaign contacts are cleared, and anyone still waiting to be called is not
called. The do-not-call entry stays, so they aren't called again.

## Not built

Each of these needs a vendor account or a business decision, rather than more
code on this side:

- **Payments.** Wallet top-ups (e.g. Razorpay) and GST invoices. Balances are
  topped up with ledger entries today.
- **Buying numbers self-serve**, or bringing your own trunk (Exotel,
  Knowlarity, Tata). Numbers are assigned from the platform's Plivo pool.
- **Voice cloning.** Sarvam's voices only.
- **Named CRM connectors** (see Integrations above).
- **Sending email.** Invites are links to copy; nothing is emailed.

## One definition of a valid agent

What counts as a valid agent configuration is defined once, in the worker's
`AgentConfigModel`, and exported to
[packages/shared/agent-config.schema.json](packages/shared/README.md) for the
control plane to validate against. Two tests keep the two sides honest: one
fails if the exported schema has drifted from the model, the other runs both
validators over the same configurations and fails if they disagree.

Regenerate after changing the model or upgrading the Sarvam plugin:

```bash
uv run python worker/scripts/export_schema.py
```

Everything below describes the worker.

## How it works

Audio flows over WebRTC between the user and the agent worker:

```
user mic --WebRTC--> LiveKit --> STT --> LLM --> TTS --> LiveKit --WebRTC--> user speakers
```

The same pipeline serves phone calls: with [telephony](#telephony-plivo) on,
Plivo bridges the PSTN to LiveKit over SIP and everything after the room is
unchanged.

All three model components are **Sarvam** — Saaras for speech recognition,
Sarvam's LLM for the conversation, and Bulbul for the voice — reached through
the native [`livekit-plugins-sarvam`](https://pypi.org/project/livekit-plugins-sarvam/)
plugin. One `SARVAM_API_KEY` covers the whole stack and billing is natively in
INR. LiveKit supplies the WebRTC transport, the VAD and the semantic turn
detector, which are model-agnostic.

Sarvam's models are built for Indian languages, so Hindi, Hinglish and the
other Indic languages are the design target rather than an afterthought.

## Setup

```bash
cp .env.example .env.local   # then fill in your credentials
uv sync
```

You need two sets of credentials:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from your
  [LiveKit Cloud](https://cloud.livekit.io) project settings.
- `SARVAM_API_KEY` from the [Sarvam dashboard](https://dashboard.sarvam.ai).
  New accounts start with ₹1,000 of free credit.

## Run

Talk to the agent with your local microphone and speakers:

```bash
uv run agent console
```

Other modes:

```bash
uv run agent dev     # connect to LiveKit, hot reload on file changes
uv run agent start   # production worker
```

### Tests

```bash
uv run pytest
```

Covers the pure logic: cost arithmetic, budget stage transitions, configuration
validation, persona loading, and that importing a module does no work. No
credentials, no network. The parts that need a live LiveKit project are checked
by making a real call rather than by mocking the SDK.

### Testing it for real

1. **Check the price before you spend anything** — `uv run costs` needs no
   credentials and no network.
2. **Add credentials** to `.env.local` from your
   [LiveKit Cloud](https://cloud.livekit.io) project.
3. **Talk to it** — `uv run agent console` uses your own mic and speakers. This
   is the fastest honest test; the console still bills real STT/TTS/LLM usage.
4. **Test Hindi and Hinglish specifically.** Say a full Hindi sentence, then a
   code-switched one like "मुझे कल की flight book करनी है". That mixed case is
   what `STT_MODE=codemix` is chosen for — it keeps the sentence as spoken
   instead of forcing it into a single script.
5. **Read the cost line** printed when the call ends, and compare it with the
   estimate.
6. **Confirm against the dashboard.** Sarvam shows what you were actually
   charged for the models; the local numbers are list-price estimates.

What to listen for: does it interrupt you mid-sentence (raise
`ENDPOINTING_MIN_DELAY`), does it feel sluggish (lower it), and does the voice
suit the caller (try another `TTS_SPEAKER`, or adjust `TTS_PACE`).

## Configuration

Set these in `.env.local`. Model, mode, language and speaker values are
validated at startup against the plugin's own tables, so a typo fails
immediately with the list of valid values rather than surfacing mid-call.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STT_MODEL` | `saaras:v4` | Speech model; `saaras:v3` is the previous generation |
| `STT_MODE` | `codemix` | How mixed speech is written down (see below) |
| `STT_LANGUAGE` | `hi-IN` | Source language hint; `unknown` auto-detects |
| `LLM_MODEL` | `sarvam-105b-conversations` | Dialogue-tuned and generally available; `sarvam-105b`, `gemma4` and `glm5.2` need beta access |
| `LLM_TEMPERATURE` | unset | Sampling temperature; omit for the model default |
| `TTS_MODEL` | `bulbul:v3` | Voice model; `bulbul:v2`, `bulbul:v3-beta` also valid |
| `TTS_LANGUAGE` | `hi-IN` | Output language, e.g. `en-IN`, `ta-IN`, `bn-IN` |
| `TTS_SPEAKER` | `ritu` | Voice; the roster is per-model (see below) |
| `TTS_PACE` | `1.0` | Speaking rate; below 1 slower, above 1 faster |
| `CALL_BUDGET_INR` | `0` | Hard ceiling per call in INR; `0` disables |
| `MAX_INR_PER_MIN` | `2` | Ceiling on cost per minute, at most ₹2 and never off; speech over it is not synthesised, except each reply's first sentence (up to ₹0.50/min more) |
| `CALL_BUDGET_WARN_AT` | `0.70` | Fraction of budget at which the agent is told to be brief |
| `CALL_BUDGET_WRAP_AT` | `0.90` | Fraction at which the agent says goodbye and hangs up |
| `CALL_BUDGET_FAREWELL` | a polite close | What the agent says when the budget ends the call |
| `MAX_RESPONSE_TOKENS` | unset | Caps any single reply, which caps TTS |
| `AGENT_PERSONA` | `assistant` | Which built-in personality to use |
| `AGENT_INSTRUCTIONS` | unset | Custom prompt, replacing the persona's character |
| `AGENT_GREETING` | persona's own | What the agent opens the call with |
| `AGENT_TIMEZONE` | `Asia/Kolkata` | The clock the agent's prompt runs on, for scripts that branch on the hour |

### Turn detection

| Variable | Default | Purpose |
| --- | --- | --- |
| `USE_TURN_DETECTOR` | `true` | Semantic end-of-turn detection; `false` uses VAD silence alone |
| `VAD_MIN_SILENCE_DURATION` | `0.25` | Trailing silence before end of speech is reported |
| `VAD_MIN_SPEECH_DURATION` | `0.05` | Minimum audio to count as speech; filters clicks and coughs |
| `VAD_ACTIVATION_THRESHOLD` | `0.5` | Speech probability to trigger; raise in noisy rooms |
| `VAD_PREFIX_PADDING_DURATION` | `0.5` | Audio kept before speech starts so the first word isn't clipped |
| `ENDPOINTING_MIN_DELAY` | `0.3` / `0.5` | Shortest wait before committing a turn |
| `ENDPOINTING_MAX_DELAY` | `2.5` / `3.0` | Longest wait before committing a turn |

### Speech modes

`STT_MODE` decides how Saaras writes down what it hears, which matters most for
a caller who mixes languages:

| Mode | "मुझे कल की flight book करनी है" becomes |
| --- | --- |
| `codemix` | kept as spoken, mixed script (default) |
| `transcribe` | native script of the source language |
| `translit` | romanised — Hindi in Latin script |
| `translate` | translated into English |
| `verbatim` | literal, including disfluencies |

### Voices

The speaker roster is **per model** — v3 replaced the v2 voices entirely, so a
v2 name like `anushka` is rejected on `bulbul:v3`. Leave `TTS_SPEAKER` unset to
get a sensible default for whichever model you chose.

| Model | Voices |
| --- | --- |
| `bulbul:v3` | *female* ritu, pooja, simran, kavya, ishita, shreya, priya, neha, roopa, amelia, sophia, suhani, rupali, tanya, shruti, kavitha<br>*male* shubh, rahul, amit, ratan, rohan, dev, manan, sumit, aditya, kabir, varun, aayan, ashutosh, advait |
| `bulbul:v2` | *female* anushka, manisha, vidya, arya<br>*male* abhilash, karun, hitesh |

Bulbul speaks `bn-IN`, `en-IN`, `gu-IN`, `hi-IN`, `kn-IN`, `ml-IN`, `mr-IN`,
`od-IN`, `pa-IN`, `ta-IN` and `te-IN`.

## Cost

Sarvam bills in **INR**, so there is no exchange rate anywhere in the
estimates. A typical call runs about **₹2.01 per minute** (₹120/hour, ₹10 for a
five-minute call).

| | Rate | ₹/min | Share |
| --- | --- | --- | --- |
| STT | ₹30/hour | 0.500 | 25% |
| TTS | ₹30/10k chars | 1.350 | 67% |
| LLM | ₹29.28/₹73.2 per Mtok in/out | 0.158 | 8% |
| | **Total** | **2.008** | |

Most Sarvam LLMs are **gated behind beta access** — only
`sarvam-105b-conversations` is generally available, and the others return a 400
until your account is enabled. It is the dialogue-tuned model, so it is the
right default for a voice agent regardless.

**TTS is two-thirds of the bill**, so the lever that actually moves cost is how
much the agent talks, not which model you pick — Sarvam charges one rate per
component regardless of model. A terse persona is a real saving; `concise`
roughly halves the TTS line against a chatty one.

The LLM estimate assumes **no cached input**. Sarvam charges ₹10.98/Mtok for
cached tokens against ₹29.28 uncached, so a long call with a stable system
prompt comes in under the estimate.

### Checking the cost

```bash
uv run costs
```

Prices your current `.env.local` and shows how the conversation shape moves it:

```
       model                            Rs/min   share
  stt  saaras:v4                    Rs  0.5000   24.9%
  tts  bulbul:v3                    Rs  1.3500   67.2%
  llm  sarvam-105b                  Rs  0.1581    7.9%
       TOTAL                        Rs  2.0081

How the conversation shape moves the cost (Rs/min)
  Agent talks little (25%)       Rs  1.333/min ( -33.6%)
  Balanced (50%, default)        Rs  2.008/min (  +0.0%) <- current
  Agent talks a lot (75%)        Rs  2.683/min ( +33.6%)
  Long context (4k tokens/turn)  Rs  2.336/min ( +16.3%)
```

Verified against a real call: a 1 minute 19 second conversation was billed
₹2.75 by Sarvam, or ₹2.09/min — within 4% of the ₹2.01/min estimate.

Rates live in [`costs.py`](worker/src/automitra_worker/costs.py) and come from
[Sarvam's pricing page](https://docs.sarvam.ai/api-reference-docs/pricing).
They are a snapshot — **the Sarvam dashboard is the authority on what you are
actually billed.** LiveKit bills separately for connection minutes.

### Capping cost per call

Sarvam bills per second, character and token, so a call's cost is not known
until it ends. `CALL_BUDGET_INR` makes it **bounded** instead:

```bash
CALL_BUDGET_INR=10      # no call may cost more than ~Rs 10
MAX_RESPONSE_TOKENS=120 # and no single reply runs long
```

Usage is recosted on every metrics event and the call is wound down in stages,
so it ends like a conversation rather than cutting out:

| Stage | Trigger | What happens |
| --- | --- | --- |
| **warn** | 70% of budget | The agent is told to keep replies to one sentence, stop opening new topics and steer to a close. Its persona is unchanged. |
| **wrap** | 90%, *or* when only the reserve is left | The agent speaks a closing line, then the session ends. |
| **hard** | 100% | The session closes immediately, mid-sentence if need be. A backstop that should not normally fire. |

The wrap stage also trips early when only enough budget remains to say
goodbye. That matters because usage arrives **per turn**, and one 400-character
reply is 12% of a ₹10 budget — wider than the 10% gap between wrap and hard. A
purely percentage-based threshold gets skipped, and the call is cut off instead
of closing. The reserve is sized in absolute terms (a farewell plus one turn in
flight), so the graceful ending is always affordable.

Because a budget bounds the worst case, it also implies a **minimum duration**.
An agent talking non-stop spends about ₹2.70/min on TTS, so:

| Budget | Guaranteed at least | Typical two-sided call |
| --- | --- | --- |
| ₹5 | ~1.5 min | ~3 min |
| ₹10 | ~3 min | ~6 min |
| ₹25 | ~8 min | ~15 min |

A budget too small to hold a conversation is rejected at startup rather than
producing a call that wraps up on its first turn.

### Holding a per-minute rate

`CALL_BUDGET_INR` bounds what a *call* costs. `MAX_INR_PER_MIN` bounds the
**rate**, which is what a per-minute price actually depends on. Every call runs
under it, and it cannot be switched off: the default and the maximum are both
**₹2/min**, an agent may ask for less (down to ₹1), and `0` means the ₹2 default.

The guarantee is that at every moment of a call, what has been spent is at most
₹2 × the minutes elapsed, except that the first sentence of each reply may take
it up to ₹2.50 × the minutes elapsed. The count never uses less than 30 seconds, so
the greeting is affordable, and 30 seconds is also the shortest billed call.
Because the limit holds at every moment, it holds whenever the caller hangs up.
It is enforced in two layers:

- **Steering.** At 80% of the allowance the agent is told to answer in one
  short sentence. At 60% the instruction is taken off again.
- **The hard limit.** Each reply passes from the model to speech synthesis one
  sentence at a time, and a sentence goes through only if it fits. One that
  does not fit yet waits up to 3 seconds for the allowance to grow. After that
  the rest of the reply is dropped. Dropped text is never synthesised, so it is
  never billed, and it does not appear in the transcript. A model request is
  billed even if nothing it writes is spoken, so room for the next request is
  always held back. A request that cannot fit is not made at all.
- **The overdraft.** The model request and the first sentence of each reply
  are measured against ₹0.50/min more than the ceiling. Held to the ceiling
  alone, an ordinary Hindi call runs out of allowance within a few turns and
  the agent meets the caller with silence; with it, a reply over the rate is
  cut to one sentence instead. It is still a hard limit, so a caller who keeps
  interrupting cannot run the cost up without bound.

Speech-to-text is a **fixed ₹0.50/min** floor, billed on call duration however
little the agent says, so it is counted first. That leaves ₹1.50/min for the
agent's speech and the model, which is about 500 characters a minute, a little
over half of continuous speech.

At list prices an ordinary two-sided call already costs about ₹2/min, so on a
talkative call expect the steering to switch on and the end of a long reply to
be cut now and then. The ceiling covers Sarvam's charges. The carrier's
per-minute rate for a phone call is separate and is not included.

Measured cost per minute by persona, at 4 turns/min:

| Persona | Avg reply | ₹/min |
| --- | --- | --- |
| `support` | 84 chars | 1.67 |
| `assistant` | 87 chars | 1.71 |
| `professional` | 90 chars | 1.74 |
| `concise` | 91 chars | 1.76 |
| `cheerful` | 93 chars | 1.78 |
| `tutor` | 103 chars | 1.89 |

### Reducing the variance

The ceiling bounds the worst case; these narrow the spread:

- **The persona prompt** is the effective lever. Telling the model to be
  brief shortens replies; `MAX_RESPONSE_TOKENS` mostly does not — measured
  against Sarvam, dropping the cap from 100 to 50 tokens left reply length
  unchanged, because it truncates mid-sentence rather than making the model
  concise, and Devanagari consumes tokens quickly.
- **`AGENT_PERSONA=concise`** roughly halves the TTS line against a chatty
  persona — with Sarvam charging one rate per component, how much the agent
  talks matters more than which model it uses.

### Measuring a real call

Estimates assume a conversation shape (agent speaking half the time, 4 turns a
minute, 1200 context tokens a turn). Your calls will differ, so the agent also
costs each session from **measured** usage — seconds transcribed, characters
synthesised, tokens spent. After any call, the log reports:

```
usage: stt=300.0s tts=2250 chars llm=24000/1200 tokens
session cost: Rs 10.0406 total (~Rs 2.008/min) [estimate, list prices]
```

Compare that against `uv run costs` to see whether your real traffic matches
the assumed profile. The number worth watching is characters synthesised — at
two-thirds of spend, that is where a wordy persona shows up.

## Personality

The agent's character comes from a named persona in
[`personas.py`](worker/src/automitra_worker/personas.py). Each one carries a system
prompt and a matching opening line.

| `AGENT_PERSONA` | Character |
| --- | --- |
| `assistant` | Neutral, capable general-purpose helper (default) |
| `cheerful` | Upbeat, energetic and encouraging |
| `concise` | Terse domain expert; minimum words, maximum signal |
| `support` | Patient customer support agent |
| `tutor` | Socratic teacher who builds understanding |
| `professional` | Polished and formal, for business contexts |
| `kbs` | Simran, inbound enquiry desk for KBS Motors (Mahindra dealership, Ambala) |

```bash
AGENT_PERSONA=tutor
```

The base rules include **replying in the user's language**: the agent answers
Hindi in Hindi, mirrors Hinglish back as Hinglish, and switches as soon as the
user does, without being asked. `TTS_LANGUAGE` is only a pronunciation hint —
Bulbul will speak whatever script the model produces, so it does not need to
change when the conversation switches.

Every prompt is composed as `VOICE_BASE_RULES + persona character`. The base
rules encode what the *medium* demands rather than the personality: no
markdown or emoji, numbers written as spoken, a few sentences at a time, one
question at a time, stop when interrupted. Those hold for every persona,
because they follow from the output being heard rather than read — a cheerful
agent is cheerful in word choice, not in extra paragraphs.

### Standalone personas

A persona that is a complete call script — one that states its own language,
brevity and identity rules — sets `standalone=True` and its prompt is used
**verbatim**, with the shared voice rules omitted. The `kbs` persona does this:
those rules open with "You are a voice assistant" and tell the model to mirror
the caller's language, both of which contradict a script for a named person who
must default to Hindi and never imply she is a bot.

The call's date and time in India is appended to every system prompt, because a
model has no clock and the `kbs` script picks its closing line from the hour.
This needs the `tzdata` package on Windows, which has no system timezone
database.

### Writing your own

`AGENT_INSTRUCTIONS` replaces the persona's character with your own text:

```bash
AGENT_INSTRUCTIONS="You are a sommelier. You are passionate about wine and
delighted to recommend pairings."
AGENT_GREETING="Greet the user and ask what they are drinking tonight."
```

The shared voice rules are **still prepended**, so a custom personality cannot
accidentally lose the constraints that make speech work. To add a permanent
persona instead, add a `Persona` entry to the `PERSONAS` dict.

## How turn detection works

Deciding when the user has finished talking is two layered signals:

1. **VAD** (Silero, running locally) answers the acoustic question: is there
   speech in this audio right now? It is fast and cheap, but it only hears
   silence — and a person pausing to think sounds exactly like a person who
   has finished.
2. **The semantic turn detector** answers the linguistic one. When VAD reports
   trailing silence, this model reads the words and prosody leading up to it
   and judges whether the thought is actually complete. "I'd like to book a
   flight to..." holds the turn; "I'd like to book a flight to Delhi" releases
   it.

The endpointing delay is the wait between VAD going quiet and committing the
turn, in `dynamic` mode scaled by the detector's confidence between
`ENDPOINTING_MIN_DELAY` and `ENDPOINTING_MAX_DELAY`. Confident endings commit
near the minimum; ambiguous ones wait longer for the user to continue.

Because the semantic model classifies the trailing audio, it needs at least
250 ms of it. Setting `VAD_MIN_SILENCE_DURATION` below `0.25` while
`USE_TURN_DETECTOR` is on is rejected at startup rather than failing mid-call.

**Tuning:** if the agent interrupts you mid-sentence, raise
`ENDPOINTING_MIN_DELAY`. If it feels sluggish, lower it. In a noisy room raise
`VAD_ACTIVATION_THRESHOLD` toward `1.0` so background sound isn't heard as
speech.

The VAD model is loaded once per worker process via a prewarm hook, so the
first conversation doesn't pay the load cost.

## Telephony (Plivo)

By default the agent is reachable over WebRTC only. Turning telephony on gives
it a phone number: callers dial in from the PSTN, and the agent can dial out.

LiveKit and Plivo do not talk to each other directly — both speak SIP, and the
two are joined by a pair of trunks:

```
caller --PSTN--> Plivo --SIP--> LiveKit SIP --> room --> agent   (inbound)
agent <-- room <-- LiveKit SIP --SIP--> Plivo --PSTN--> callee   (outbound)
```

Once a call lands in a room nothing downstream changes. The same persona,
budget and turn detection apply whether the audio arrived over a phone line or
a browser.

### Setting it up

1. **Buy a number and create a credentials list** in the
   [Plivo console](https://console.plivo.com) under Zentrunk.

2. **Fill in the `PLIVO_*` settings** in `.env.local`, and set
   `TELEPHONY_ENABLED=true`. At minimum you need `PLIVO_PHONE_NUMBERS`,
   `PLIVO_SIP_USERNAME` and `PLIVO_SIP_PASSWORD`.

3. **Provision the LiveKit side:**

   ```bash
   uv run telephony
   ```

   This creates (or updates, on a rerun) an inbound trunk, an outbound trunk
   and a dispatch rule, then prints the SIP URI and credentials to paste into
   Plivo. It is idempotent — rerun it after any config change.

4. **Finish the Plivo side** using what that command printed: point your
   numbers at an outbound Plivo trunk aimed at the LiveKit SIP URI, and create
   an inbound Plivo trunk with the same credentials list so LiveKit can send
   calls out.

5. **Run the worker.** If you set `TELEPHONY_AGENT_NAME`, register the worker
   under that same name so the dispatch rule can target it:

   ```bash
   uv run agent start
   ```

### Placing a call

```bash
uv run call +919876543210
```

That dispatches the agent into a fresh room, dials the number through Plivo,
and returns once the callee actually answers — so a busy signal or a decline
surfaces as an error rather than a call that silently never connects. Use
`--from` to pick a caller ID other than the first of your numbers.

### Things worth knowing

- **Plivo bills separately.** `uv run costs` and the per-call cost lines cover
  Sarvam only. PSTN minutes are a Plivo charge on top, and they are usually the
  larger number on a long call.
- **`TELEPHONY_MAX_CALL_SECONDS` is worth setting even with a budget.**
  `CALL_BUDGET_INR` bounds spend, which a silent line barely touches; a caller
  who puts you on hold and walks away holds a phone line open indefinitely.
  This caps wall-clock instead.
- **Noise cancellation matters more here.** Phone audio is narrowband and
  noisier than a laptop mic, and Sarvam's STT sees the difference.
  `TELEPHONY_KRISP=true` is the default for that reason.
- **The inbound trunk is refused if it would be wide open.** With neither
  credentials nor `PLIVO_ALLOWED_ADDRESSES`, anyone who finds the SIP URI can
  place calls you pay for, so startup fails rather than accepting it.
- **Test with `uv run agent console` first.** The persona and turn detection
  are easier to tune over your own mic than over a phone line, and the phone
  path changes neither.

## Worker modules

| File | Role |
| --- | --- |
| `worker/src/automitra_worker/personas.py` | Built-in personalities and shared voice rules |
| `worker/src/automitra_worker/costs.py` | Rate cards, cost estimation, actual-usage costing |
| `worker/src/automitra_worker/cli.py` | The `uv run costs` command |
| `worker/src/automitra_worker/telephony.py` | Plivo/SIP config, trunk provisioning, outbound calls |
| `worker/src/automitra_worker/telephony_cli.py` | The `uv run telephony` and `uv run call` commands |
| `worker/src/automitra_worker/config.py` | Reads and validates env vars into `AgentConfig` |
| `worker/src/automitra_worker/agent.py` | Builds the `AgentSession` and defines the worker entry point |
| `worker/src/automitra_worker/tools.py` | Customer HTTP tools: the pinned, SSRF-checked request and response shaping |
| `worker/src/automitra_worker/call_control.py` | `end_call`, `transfer_call`, classifying a failed dial |
| `worker/src/automitra_worker/variables.py` | `{{placeholder}}` substitution for prompts and tool responses |
| `worker/src/automitra_worker/analysis.py` | Post-call summary, disposition and fields |
| `worker/src/automitra_worker/recording.py` | Starting LiveKit Egress to object storage |
| `worker/src/automitra_worker/knowledge.py` | The `search_knowledge` tool |
| `worker/src/automitra_worker/latency.py` | Per-turn reply latency from the SDK metrics |
| `worker/src/automitra_worker/evals.py` | Simulated-caller test runs and their judge |
| `worker/src/automitra_worker/eval_cli.py` | The `uv run evals` command |
| `worker/src/automitra_worker/seed_personas/` | Business-specific call scripts, as data rather than source |

## Notes

- `USE_TURN_DETECTOR=true` loads a local transformer model that decides when
  you have actually finished a sentence, instead of barging in at the first
  pause. Weights are fetched once via `uv run python -m livekit.agents download-files`.
- `.env` and `.env.local` are gitignored; `.env.example` is the template to commit.
- `SARVAM_API_KEY` is read from the environment by the plugin itself, so it
  never has to be passed in code.
