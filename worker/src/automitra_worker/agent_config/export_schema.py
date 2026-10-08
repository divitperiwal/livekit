"""Write the JSON Schemas the API builds on: the agent configuration it validates, and the
`/internal/*` contract it implements.

    uv run python -m automitra_worker.agent_config.export_schema           # write
    uv run python -m automitra_worker.agent_config.export_schema --check   # fail on drift
"""

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from zoneinfo import available_timezones

from pydantic.json_schema import models_json_schema

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.agent_config.sarvam_catalog import TTS_SPEAKERS_BY_MODEL
from automitra_worker.control_plane.contract import CONTRACT_MODELS

SCHEMA_DIRECTORY = Path(__file__).resolve().parents[4] / "schema"
REPOSITORY_SCHEMA_PATH = SCHEMA_DIRECTORY / "agent-config.schema.json"
INTERNAL_API_SCHEMA_PATH = SCHEMA_DIRECTORY / "internal-api.schema.json"
JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def build_agent_config_schema() -> dict:
    schema = {
        "$schema": JSON_SCHEMA_DIALECT,
        **AgentConfigModel.model_json_schema(by_alias=True, mode="validation"),
    }
    schema["x-tts-speakers"] = {
        model: list(speakers) for model, speakers in TTS_SPEAKERS_BY_MODEL.items()
    }
    schema["x-timezones"] = sorted(available_timezones())
    return schema


def build_internal_api_schema() -> dict:
    _, definitions = models_json_schema(
        [(model, "validation") for model in CONTRACT_MODELS], by_alias=True
    )
    return {
        "$schema": JSON_SCHEMA_DIALECT,
        "title": "automitra worker <-> API internal contract",
        "description": "Request and response bodies of /internal/*. See control_plane/contract.py.",
        **definitions,
    }


SCHEMAS: dict[Path, Callable[[], dict]] = {
    REPOSITORY_SCHEMA_PATH: build_agent_config_schema,
    INTERNAL_API_SCHEMA_PATH: build_internal_api_schema,
}


def render_schema(schema: dict) -> str:
    return json.dumps(schema, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check", action="store_true", help="exit 1 if a committed schema is stale"
    )
    arguments = parser.parse_args()

    stale = []
    for path, build in SCHEMAS.items():
        rendered = render_schema(build())
        if arguments.check:
            committed = path.read_text(encoding="utf-8") if path.exists() else ""
            if committed != rendered:
                stale.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8", newline="\n")
        print(f"wrote {path}")

    for path in stale:
        print(f"{path} is stale. Run export_schema without --check.", file=sys.stderr)
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
