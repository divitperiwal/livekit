"""Filling a call's values into its prompt and greeting.

The failure worth guarding against is audible: an agent that reads
"curly-brace name" to a caller, or one whose prompt can be rewritten by
whatever a contact's name field happened to contain.
"""

from __future__ import annotations

from automitra_worker.config import AgentConfig
from automitra_worker.variables import MAX_VALUE_CHARS, clean, render


def test_values_are_substituted() -> None:
    assert render("Namaste {{name}}, order {{order_id}}.", {"name": "Asha", "order_id": "A12"}) == (
        "Namaste Asha, order A12."
    )


def test_whitespace_inside_braces_is_tolerated() -> None:
    assert render("Hi {{ name }}", {"name": "Ravi"}) == "Hi Ravi"


def test_a_missing_value_is_never_read_aloud_as_braces() -> None:
    assert render("Hello {{name}}.", {}) == "Hello ."


def test_a_default_covers_a_missing_value() -> None:
    assert render("Hello {{name|there}}.", {}) == "Hello there."
    assert render("Hello {{name|there}}.", {"name": ""}) == "Hello there."
    assert render("Hello {{name|there}}.", {"name": "Meera"}) == "Hello Meera."


def test_substitution_is_a_single_pass() -> None:
    """A value is text, not a template: it cannot pull in another variable."""
    rendered = render("Hi {{name}}", {"name": "{{secret}}", "secret": "leaked"})
    assert rendered == "Hi {{secret}}"


def test_dotted_paths_walk_json() -> None:
    data = {"order": {"status": "shipped", "items": [{"sku": "X1"}]}}
    assert render("{{order.status}} {{order.items.0.sku}}", data) == "shipped X1"
    assert render("{{order.missing|unknown}}", data) == "unknown"


def test_a_flat_key_with_dots_wins_over_a_path() -> None:
    assert render("{{order.id}}", {"order.id": "flat", "order": {"id": "nested"}}) == "flat"


def test_clean_flattens_whatever_arrived() -> None:
    cleaned = clean(
        {
            "name": "  Asha ",
            "amount": 1250,
            "vip": True,
            "tags": ["a", "b"],
            "nothing": None,
            "": "blank key",
            7: "not a string key",
        }
    )
    assert cleaned == {"name": "Asha", "amount": "1250", "vip": "yes", "tags": '["a", "b"]'}


def test_clean_rejects_what_is_not_a_mapping() -> None:
    for raw in (None, "text", [1, 2], 5):
        assert clean(raw) == {}


def test_clean_caps_long_values() -> None:
    assert len(clean({"note": "x" * 5000})["note"]) == MAX_VALUE_CHARS


def test_config_renders_prompt_greeting_and_voicemail() -> None:
    config = AgentConfig.from_record(
        {
            "instructions": "You are calling {{name}} about invoice {{invoice}}.",
            "greeting": "Namaste {{name|ji}}!",
            "config": {"voicemailMessage": "Hi {{name}}, please call us back."},
        }
    ).with_variables({"name": "Asha", "invoice": "INV-7"})

    assert "calling Asha about invoice INV-7" in config.instructions
    assert config.greeting == "Namaste Asha!"
    assert config.voicemail_message == "Hi Asha, please call us back."


def test_config_renders_even_without_values() -> None:
    config = AgentConfig.from_record(
        {"instructions": "Prompt", "greeting": "Namaste {{name|ji}}!", "config": {}}
    ).with_variables({})
    assert config.greeting == "Namaste ji!"
