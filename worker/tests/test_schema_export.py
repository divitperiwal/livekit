"""Keeps the exported JSON Schema in step with the model it came from.

The control plane validates a saved agent against the committed schema; the
worker validates the same configuration against the pydantic model. If those
two drift, a configuration saves cleanly in the dashboard and then fails on a
live call -- which is the failure this whole arrangement exists to prevent.

The drift can happen two ways: someone edits the model and forgets to
regenerate, or the Sarvam plugin is upgraded and its model list changes
underneath both. This test catches either.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from automitra_worker.agent_config_model import AgentConfigModel

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "worker" / "scripts" / "export_schema.py"
SCHEMA = REPO / "packages" / "shared" / "agent-config.schema.json"


def test_committed_schema_matches_the_model() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--check"],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    assert result.returncode == 0, (
        result.stdout + result.stderr
    )


def test_schema_covers_every_field() -> None:
    """A field the schema does not know about is one the dashboard cannot set."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert set(schema["properties"]) == set(AgentConfigModel.model_fields)


def test_schema_rejects_unknown_fields() -> None:
    """Mirrors the model's `extra="forbid"`.

    Without this the dashboard would silently accept a misspelled field, store
    it, and the worker would then reject the whole configuration at call time.
    """
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["additionalProperties"] is False


@pytest.mark.parametrize(
    ("field", "expected"),
    [
        ("stt_model", "saaras:v4"),
        ("tts_model", "bulbul:v3"),
        ("llm_model", "sarvam-105b-conversations"),
    ],
)
def test_enumerated_fields_carry_real_values(field: str, expected: str) -> None:
    """The enums come from the installed plugin, not from a copied list."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert expected in schema["properties"][field]["enum"]


def test_schema_records_the_plugin_version_it_came_from() -> None:
    """So a reader can tell whether an upgrade has invalidated these enums."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["x-sarvam-plugin-version"] != "unknown"
