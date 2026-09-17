# automitra-worker

The LiveKit agent worker. It owns one thing: the live call.

Speech-to-text, the language model and text-to-speech are all Sarvam, reached
through the native `livekit-plugins-sarvam` plugin. LiveKit supplies the WebRTC
transport, the voice activity detection and the semantic turn detector, which
are model-agnostic. Plivo bridges the phone network over SIP.

## Where this sits

```
Bun API  ──  agent config, call records, usage  ──┐
                                                  │  HTTP
caller ──PSTN──> Plivo ──SIP──> LiveKit ──> room ──> worker (this package)
```

The worker holds no database credentials and owns no schema. It reads the agent
configuration it needs at the start of a call and posts transcripts and usage
back when the call ends. Everything else — who the customer is, what they are
billed, which number belongs to whom — belongs to the API.

Today configuration still comes from the environment; see the repository README
for how that becomes a per-tenant lookup.

## Running it

```bash
uv run agent console   # talk to it with your own mic and speakers
uv run agent dev       # connect to LiveKit, reload on change
uv run agent start     # production worker

uv run costs           # price the current configuration, no credentials needed
uv run telephony       # provision the Plivo/LiveKit SIP bridge
uv run call +91...     # place an outbound call
```

## Tests

```bash
uv run pytest
```

The suite covers the pure logic — cost arithmetic, budget stage transitions,
configuration validation, persona loading. It needs no credentials and no
network. The parts that need a live LiveKit project are verified by making a
real call, not by mocking the SDK.
