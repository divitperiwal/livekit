"""Tests for the persona registry and the seed files behind it.

The business-specific personas load their prompt and greeting from
``seed_personas/`` rather than from source. These tests guard the two ways that
can break: the files going missing from an installed package, and the loader
quietly altering the content it reads.
"""

from __future__ import annotations

import pytest

from livekit_python.personas import (
    PERSONAS,
    SEED_DIR,
    VOICE_BASE_RULES,
    get_persona,
)


def test_every_persona_has_a_prompt_and_a_greeting() -> None:
    for name, persona in PERSONAS.items():
        assert persona.prompt.strip(), f"{name} has an empty prompt"
        assert persona.greeting.strip(), f"{name} has an empty greeting"
        assert persona.name == name, f"{name} disagrees with its registry key"


def test_seed_files_are_present() -> None:
    """Catches the packaging failure: works locally, missing once installed."""
    assert (SEED_DIR / "kbs.prompt.txt").is_file()
    assert (SEED_DIR / "kbs.greeting.txt").is_file()


def test_seed_content_is_loaded_verbatim() -> None:
    """The loader strips trailing newlines and must change nothing else.

    This is an operational script owned by the business; a loader that mangled
    whitespace or re-wrapped lines would change agent behaviour silently.
    """
    raw = (SEED_DIR / "kbs.prompt.txt").read_text(encoding="utf-8")
    assert get_persona("kbs").prompt == raw.rstrip("\n")


def test_kbs_prompt_survived_extraction_intact() -> None:
    """Spot-checks the operational details that make this script work.

    Each of these is a rule the dealership depends on, and each would be easy
    to lose in a bad extraction without any test noticing.
    """
    prompt = get_persona("kbs").prompt
    assert "1800 102 7006" in prompt or "one eight zero zero" in prompt
    assert "Simran" in prompt
    assert "insurance" in prompt.lower()


def test_kbs_greeting_keeps_its_devanagari() -> None:
    """Guards against an encoding mishap turning the greeting into mojibake."""
    greeting = get_persona("kbs").greeting
    assert "नमस्कार" in greeting
    assert "KBS Motors" in greeting


def test_standalone_persona_uses_its_prompt_verbatim() -> None:
    kbs = get_persona("kbs")
    assert kbs.standalone
    assert kbs.instructions() == kbs.prompt.strip()
    assert VOICE_BASE_RULES not in kbs.instructions()


def test_ordinary_persona_gets_the_shared_rules_first() -> None:
    assistant = get_persona("assistant")
    assert not assistant.standalone
    assert assistant.instructions().startswith(VOICE_BASE_RULES)


@pytest.mark.parametrize("name", ["KBS", "  kbs  ", "Kbs"])
def test_lookup_normalises_the_name(name: str) -> None:
    assert get_persona(name).name == "kbs"


def test_unknown_persona_suggests_the_alternatives() -> None:
    with pytest.raises(ValueError) as exc:
        get_persona("nonexistent")
    message = str(exc.value)
    assert "assistant" in message
    assert "AGENT_INSTRUCTIONS" in message
