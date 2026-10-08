import pytest

from automitra_worker.agent_config.personas import PERSONAS, SEED_DIRECTORY, get_persona
from automitra_worker.pipeline.prompt import VOICE_BASE_RULES


def test_every_persona_has_a_prompt_and_a_greeting():
    for name, persona in PERSONAS.items():
        assert persona.prompt.strip() and persona.greeting.strip(), name
        assert persona.name == name


def test_seed_files_ship_with_the_package():
    assert (SEED_DIRECTORY / "kbs.prompt.txt").is_file()
    assert (SEED_DIRECTORY / "kbs.greeting.txt").is_file()
    assert (SEED_DIRECTORY / "kbs.closing.json").is_file()


def test_the_business_script_is_loaded_verbatim():
    raw = (SEED_DIRECTORY / "kbs.prompt.txt").read_text(encoding="utf-8")
    assert get_persona("kbs").prompt == raw.rstrip("\n")


def test_kbs_script_keeps_the_details_the_dealership_depends_on():
    prompt = get_persona("kbs").prompt
    assert "1800 102 7006" in prompt or "one eight zero zero" in prompt
    assert "Simran" in prompt
    assert "insurance" in prompt.lower()
    greeting = get_persona("kbs").greeting
    assert "नमस्कार" in greeting and "KBS Motors" in greeting


def test_kbs_leaves_the_closing_line_to_the_worker():
    prompt = get_persona("kbs").prompt
    assert "end_call" in prompt
    assert "दस से पंद्रह" not in prompt
    assert any("दस से पंद्रह" in line.text for line in get_persona("kbs").closing_lines)


def test_a_standalone_persona_runs_its_script_without_the_shared_rules():
    kbs = get_persona("kbs")
    assert kbs.standalone
    assert kbs.instructions() == kbs.prompt.strip()
    assert VOICE_BASE_RULES not in kbs.instructions()


def test_an_ordinary_persona_gets_the_shared_rules_first():
    assert get_persona("assistant").instructions().startswith(VOICE_BASE_RULES)


@pytest.mark.parametrize("name", ["KBS", "  kbs  ", "Kbs"])
def test_lookup_ignores_case_and_spaces(name):
    assert get_persona(name).name == "kbs"


def test_unknown_persona_suggests_the_alternatives():
    with pytest.raises(ValueError) as error:
        get_persona("nonexistent")
    assert "assistant" in str(error.value) and "AGENT_INSTRUCTIONS" in str(error.value)
