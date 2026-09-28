"""Post-call analysis: what the model says, and what is allowed to be stored.

The model's reply is untrusted input. These pin down that a disposition the
business never defined, a field of the wrong type, or a reply that is not
JSON at all never reaches the call record -- and that the tokens spent are
reported whatever the reply was, since they are billed either way.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from livekit.agents import llm

from automitra_worker.agent_config_model import DEFAULT_DISPOSITIONS, AgentConfigModel, AnalysisField
from automitra_worker.analysis import MAX_TRANSCRIPT_CHARS, analyse, build_prompt, parse, transcript_text

DISPOSITIONS = ("interested", "not_interested", "callback_requested")
FIELDS = (
    AnalysisField(name="callback_time", type="string", description="When to call back"),
    AnalysisField(name="budget", type="number"),
    AnalysisField(name="test_drive", type="boolean"),
    AnalysisField(name="model", type="enum", options=["XUV700", "Thar", "Scorpio-N"]),
    AnalysisField(name="notes", type="enum"),
)


def test_a_clean_reply() -> None:
    raw = (
        '{"summary": "Asked about the Thar.", "disposition": "interested", "fields": '
        '{"callback_time": "tomorrow 5pm", "budget": 1500000, "test_drive": true, "model": "Thar", "notes": "wants red"}}'
    )
    assert parse(raw, DISPOSITIONS, FIELDS) == (
        "Asked about the Thar.",
        "interested",
        {"callback_time": "tomorrow 5pm", "budget": 1500000, "test_drive": True, "model": "Thar", "notes": "wants red"},
    )


def test_fences_and_chatter_around_the_json_are_tolerated() -> None:
    raw = 'Sure!\n```json\n{"summary": "S", "disposition": "Interested", "fields": {}}\n```'
    summary, disposition, _ = parse(raw, DISPOSITIONS, FIELDS)  # type: ignore[misc]
    assert (summary, disposition) == ("S", "interested")


def test_a_disposition_the_business_never_defined_is_dropped() -> None:
    _, disposition, _ = parse('{"disposition": "very_interested"}', DISPOSITIONS, FIELDS)  # type: ignore[misc]
    assert disposition is None


def test_labels_match_ignoring_case_and_spacing() -> None:
    _, disposition, _ = parse('{"disposition": "Callback Requested"}', DISPOSITIONS, FIELDS)  # type: ignore[misc]
    assert disposition == "callback_requested"


def test_values_are_coerced_or_dropped() -> None:
    raw = (
        '{"fields": {"budget": "Rs 15,00,000", "test_drive": "haan", "model": "thar", '
        '"callback_time": {"nested": 1}, "unasked": "ignored"}}'
    )
    _, _, fields = parse(raw, DISPOSITIONS, FIELDS)  # type: ignore[misc]
    assert fields == {
        "budget": 1500000,
        "test_drive": True,
        "model": "Thar",
        "callback_time": None,
        "notes": None,
    }


def test_a_value_outside_an_enum_is_dropped() -> None:
    _, _, fields = parse('{"fields": {"model": "Fortuner"}}', DISPOSITIONS, FIELDS)  # type: ignore[misc]
    assert fields["model"] is None


def test_a_boolean_is_not_a_number() -> None:
    _, _, fields = parse('{"fields": {"budget": true}}', DISPOSITIONS, FIELDS)  # type: ignore[misc]
    assert fields["budget"] is None


def test_not_json_at_all() -> None:
    assert parse("The caller was interested.", DISPOSITIONS, FIELDS) is None


def test_the_prompt_lists_what_the_business_asked_for() -> None:
    prompt = build_prompt("Caller: hi", DISPOSITIONS, FIELDS)
    assert "Dispositions: interested, not_interested, callback_requested" in prompt
    assert '"model" (one of: "XUV700", "Thar", "Scorpio-N")' in prompt
    assert '"notes" (string)' in prompt
    assert prompt.endswith("Caller: hi")


def test_the_transcript_keeps_the_end_of_a_long_call() -> None:
    chat = llm.ChatContext.empty()
    chat.add_message(role="system", content="not part of the call")
    chat.add_message(role="assistant", content="Namaste")
    chat.add_message(role="user", content="x" * (MAX_TRANSCRIPT_CHARS + 100))
    chat.add_message(role="user", content="final words")
    text, caller_turns = transcript_text(chat)
    assert caller_turns == 2
    assert "not part of the call" not in text
    assert text.endswith("Caller: final words")
    assert text.startswith("[earlier part of the call omitted]")


class FakeLLM:
    """Streams a fixed reply, with usage on the last chunk, as the plugin does."""

    def __init__(self, reply: str, *, fail: bool = False) -> None:
        self.reply = reply
        self.fail = fail
        self.seen: Any = None

    def chat(self, *, chat_ctx: llm.ChatContext) -> Any:
        self.seen = chat_ctx
        fake = self

        class Stream:
            async def __aenter__(self) -> Any:
                if fake.fail:
                    raise RuntimeError("model unavailable")
                return self

            async def __aexit__(self, *_: object) -> None:
                return None

            def __aiter__(self) -> Any:
                async def gen() -> Any:
                    for part in (fake.reply[: len(fake.reply) // 2], fake.reply[len(fake.reply) // 2 :]):
                        yield SimpleNamespace(delta=SimpleNamespace(content=part), usage=None)
                    yield SimpleNamespace(
                        delta=None,
                        usage=SimpleNamespace(prompt_tokens=900, completion_tokens=60, prompt_cached_tokens=100),
                    )

                return gen()

        return Stream()


async def test_analyse_reports_the_result_and_its_tokens() -> None:
    model = FakeLLM('{"summary": "S", "disposition": "interested", "fields": {"budget": 5}}')
    result = await analyse(model, "Caller: hi", DISPOSITIONS, FIELDS)  # type: ignore[arg-type]
    assert result is not None
    assert result.as_payload()["disposition"] == "interested"
    assert (result.prompt_tokens, result.completion_tokens, result.cached_tokens) == (900, 60, 100)


async def test_tokens_are_reported_even_for_a_useless_reply() -> None:
    result = await analyse(FakeLLM("I cannot help with that."), "Caller: hi", DISPOSITIONS, FIELDS)  # type: ignore[arg-type]
    assert result is not None
    assert result.summary is None
    assert result.prompt_tokens == 900


async def test_a_failing_model_is_swallowed() -> None:
    assert await analyse(FakeLLM("", fail=True), "Caller: hi", DISPOSITIONS, FIELDS) is None  # type: ignore[arg-type]


def test_config_defaults_and_limits() -> None:
    model = AgentConfigModel.model_validate({})
    assert tuple(model.dispositions) == DEFAULT_DISPOSITIONS
    assert model.analysis_enabled
    for bad in (
        {"analysis_fields": [{"name": "Has Space"}]},
        {"analysis_fields": [{"name": "x", "type": "date"}]},
        {"dispositions": []},
        {"dispositions": [""]},
    ):
        with pytest.raises(ValueError):
            AgentConfigModel.model_validate(bad)
