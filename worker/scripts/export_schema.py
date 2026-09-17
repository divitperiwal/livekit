"""Write the agent-configuration JSON Schema for the control plane.

    uv run python worker/scripts/export_schema.py

The worker owns what a valid agent configuration is, because the valid models,
languages and voices come from the Sarvam plugin's own tables and change when
that plugin is upgraded. The control plane has to enforce the same rules when a
customer saves an agent, and cannot import this model to do it -- the plugin
pulls in the whole voice stack.

So the rules are exported instead. This script writes them; a test fails if the
committed copy has drifted from the model. The alternative -- maintaining the
same constraints twice, in Python and in TypeScript -- produces two definitions
that agree on the day they are written and quietly diverge after.

The output is checked in. Regenerate it whenever the model changes or the
Sarvam plugin is upgraded.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from zoneinfo import available_timezones

from automitra_worker.agent_config_model import (
    TTS_MODELS,
    AgentConfigModel,
    tts_speakers,
)

# Written into the schema so a reader can tell which plugin version produced
# these enums.
PLUGIN = "livekit-plugins-sarvam"

DEST = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "shared"
    / "agent-config.schema.json"
)


def plugin_version() -> str:
    """The installed Sarvam plugin version, or 'unknown' if it cannot be read."""
    try:
        from importlib.metadata import version

        return version(PLUGIN)
    except Exception:
        return "unknown"


def build() -> dict:
    schema = AgentConfigModel.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["title"] = "AgentConfig"
    schema["description"] = (
        "The stored configuration of an agent version. Generated from "
        "automitra_worker.agent_config_model; edit that model, not this file. "
        f"Enumerated values come from {PLUGIN} {plugin_version()}."
    )
    # Keys in the schema are the storage names. The control plane stores JSON
    # camelCased and converts at the boundary.
    schema["x-generated-by"] = "worker/scripts/export_schema.py"
    schema["x-sarvam-plugin-version"] = plugin_version()

    # Which voices exist on which TTS model.
    #
    # This is a relationship between two fields rather than a constraint on
    # either, so JSON Schema cannot express it and pydantic enforces it in a
    # model validator that generates nothing. Exported separately so the
    # control plane can apply the same rule instead of accepting a voice the
    # worker will reject once a call is already connected.
    schema["x-tts-speakers"] = {
        model: list(tts_speakers(model)) for model in TTS_MODELS
    }

    # Valid IANA timezone names.
    #
    # Same problem as the speaker roster: pydantic checks this by constructing
    # a ZoneInfo, which produces no schema. Exported as a plain enum rather
    # than a list of several hundred names in the property itself, so the
    # schema stays readable.
    schema["x-timezones"] = sorted(available_timezones())
    return schema


def main() -> int:
    schema = build()
    text = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"

    if "--check" in sys.argv:
        if not DEST.exists():
            print(f"{DEST} does not exist; run this script without --check")
            return 1
        current = DEST.read_text(encoding="utf-8")
        if current != text:
            print(
                f"{DEST.name} is out of date with the model.\n"
                "Run: uv run python worker/scripts/export_schema.py"
            )
            return 1
        print(f"{DEST.name} is up to date")
        return 0

    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(text, encoding="utf-8")
    print(f"wrote {DEST} ({len(schema['properties'])} properties)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
