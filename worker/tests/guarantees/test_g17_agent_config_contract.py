import json

import pytest
from pydantic import ValidationError

from automitra_worker.agent_config.export_schema import (
    REPOSITORY_SCHEMA_PATH,
    build_agent_config_schema,
    render_schema,
)
from automitra_worker.agent_config.model import AgentConfigModel

SHARED_CASES_PATH = REPOSITORY_SCHEMA_PATH.with_name("agent-config.cases.json")
SHARED_CASES = json.loads(SHARED_CASES_PATH.read_text(encoding="utf-8"))


def test_committed_schema_matches_the_model():
    committed = REPOSITORY_SCHEMA_PATH.read_text(encoding="utf-8")
    assert committed == render_schema(build_agent_config_schema()), (
        "schema/agent-config.schema.json is stale: "
        "run `uv run python -m automitra_worker.agent_config.export_schema`"
    )


@pytest.mark.parametrize("case", SHARED_CASES["valid"], ids=lambda case: case["name"])
def test_model_accepts_every_shared_valid_config(case):
    AgentConfigModel.from_stored(case["config"])


@pytest.mark.parametrize("case", SHARED_CASES["invalid"], ids=lambda case: case["name"])
def test_model_rejects_every_shared_invalid_config(case):
    with pytest.raises(ValidationError):
        AgentConfigModel.from_stored(case["config"])
