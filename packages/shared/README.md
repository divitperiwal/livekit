# packages/shared

Generated artefacts that the control plane and the worker both depend on.

## agent-config.schema.json

What counts as a valid agent configuration. **Generated — do not edit.**

```bash
uv run python worker/scripts/export_schema.py            # regenerate
uv run python worker/scripts/export_schema.py --check    # fail if stale
```

The worker owns these rules, because the valid models, languages and voices
come from `livekit-plugins-sarvam`'s own type tables and change when that
plugin is upgraded. The control plane has to enforce the same rules when a
customer saves an agent, and cannot import the Python model to do it: the
plugin pulls in the entire voice stack, which an API process has no business
installing.

So the rules are exported instead, and two tests hold the arrangement together:

- `worker/tests/test_schema_export.py` fails if this file has drifted from the
  model it was generated from.
- `apps/api/src/db/agreement.test.ts` runs both validators over the same
  configurations and fails if they disagree about any of them.

Writing the rules twice, once in Python and once in TypeScript, would produce
two definitions that agree on the day they are written and diverge afterwards.
The symptom is a configuration that saves cleanly in the dashboard and then
fails at three in the morning on a live call.

### The two extension keys

Some rules cannot be expressed in JSON Schema, so they are exported as data
beside it:

- `x-tts-speakers` — which voices exist on which TTS model. The rosters are
  per-model (`bulbul:v3` replaced the v2 voices wholesale), so this is a
  relationship between two fields rather than a constraint on either.
- `x-timezones` — valid IANA zone names, which the worker checks by
  constructing a `ZoneInfo`.

Both are applied by hand in `apps/api/src/db/validate-config.ts`. They are also
what populates the dashboard's dropdowns, so a customer picks from the real
list rather than typing a name and hoping.

### Casing

Keys here are the storage names, in `snake_case`, matching the worker's model.
The control plane stores and serves JSON in `camelCase` and converts at the
boundary. `AgentConfig.from_record` accepts either.
