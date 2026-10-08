from types import SimpleNamespace
from typing import Any

from livekit.agents import llm

from automitra_worker.agent_config.model import AnalysisField
from automitra_worker.reporting.analysis import (
    MAX_TRANSCRIPT_CHARS,
    analyse_call,
    build_prompt,
    checked_analysis,
    transcript_text,
)

DISPOSITIONS = ["interested", "not_interested", "callback_requested"]
FIELDS = [
    AnalysisField(name="callback_time", type="string", description="When to call back"),
    AnalysisField(name="budget", type="number"),
    AnalysisField(name="test_drive", type="boolean"),
    AnalysisField(name="model", type="enum", options=["XUV700", "Thar", "Scorpio-N"]),
    AnalysisField(name="notes", type="enum"),
]
QA = ["Greeted the caller by name", "Offered a test drive"]


def check(raw: str, qa: list[str] | None = None):
    return checked_analysis(raw, DISPOSITIONS, FIELDS, qa or [])


def test_a_clean_reply_is_kept_whole():
    analysis = check(
        '{"summary": "Asked about the Thar.", "disposition": "interested", "fields": {"callback_time": "tomorrow 5pm",'
        ' "budget": 1500000, "test_drive": true, "model": "Thar", "notes": "wants red"}}'
    )
    assert (analysis.summary, analysis.disposition) == ("Asked about the Thar.", "interested")
    assert analysis.fields == {
        "callback_time": "tomorrow 5pm",
        "budget": 1500000,
        "test_drive": True,
        "model": "Thar",
        "notes": "wants red",
    }


def test_fences_and_chatter_around_the_json_are_tolerated_and_labels_match_loosely():
    analysis = check(
        'Sure!\n```json\n{"summary": "S", "disposition": "Callback Requested", "fields": {}}\n```'
    )
    assert (analysis.summary, analysis.disposition) == ("S", "callback_requested")


def test_values_are_coerced_to_their_type_or_dropped():
    analysis = check(
        '{"fields": {"budget": "Rs 15,00,000", "test_drive": "haan", "model": "thar", '
        '"callback_time": {"nested": 1}, "unasked": "ignored"}}'
    )
    assert analysis.fields == {
        "budget": 1500000,
        "test_drive": True,
        "model": "Thar",
        "callback_time": None,
        "notes": None,
    }


def test_not_json_at_all_is_no_analysis():
    assert check("The caller was interested.") is None


def test_qa_verdicts_follow_the_agents_criteria_with_unclear_as_none():
    analysis = check('{"qa": {"1": true, "2": "maybe"}}', QA)
    assert [(verdict.criterion, verdict.passed) for verdict in analysis.qa] == [
        (QA[0], True),
        (QA[1], None),
    ]


def test_the_prompt_lists_what_the_business_asked_for():
    prompt = build_prompt("Caller: hi", DISPOSITIONS, FIELDS, QA)
    assert "Dispositions: interested, not_interested, callback_requested" in prompt
    assert '"model" (one of: "XUV700", "Thar", "Scorpio-N")' in prompt
    assert '"notes" (string)' in prompt
    assert '- "2": Offered a test drive' in prompt
    assert prompt.endswith("Caller: hi")


def test_the_transcript_keeps_the_end_of_a_long_call():
    chat = llm.ChatContext.empty()
    chat.add_message(role="system", content="not part of the call")
    chat.add_message(role="assistant", content="Namaste")
    chat.add_message(role="user", content="x" * (MAX_TRANSCRIPT_CHARS + 100))
    chat.add_message(role="user", content="final words")
    text, caller_turns = transcript_text(chat)
    assert caller_turns == 2 and "not part of the call" not in text
    assert text.endswith("Caller: final words") and text.startswith(
        "[earlier part of the call omitted]"
    )


class FakeLLM:
    """Streams a fixed reply, usage on the last chunk, as the Sarvam plugin does."""

    def __init__(self, reply: str, *, fail: bool = False) -> None:
        self.reply, self.fail = reply, fail

    def chat(self, *, chat_ctx: llm.ChatContext) -> Any:
        fake = self

        class Stream:
            async def __aenter__(self):
                if fake.fail:
                    raise RuntimeError("model unavailable")
                return self

            async def __aexit__(self, *exception):
                return None

            def __aiter__(self):
                async def chunks():
                    half = len(fake.reply) // 2
                    for part in (fake.reply[:half], fake.reply[half:]):
                        yield SimpleNamespace(delta=SimpleNamespace(content=part), usage=None)
                    yield SimpleNamespace(
                        delta=None,
                        usage=SimpleNamespace(
                            prompt_tokens=900, completion_tokens=60, prompt_cached_tokens=100
                        ),
                    )

                return chunks()

        return Stream()


async def test_the_result_carries_its_tokens_even_for_a_useless_reply():
    useful = await analyse_call(
        FakeLLM('{"summary": "S", "disposition": "interested"}'),
        "Caller: hi",
        DISPOSITIONS,
        FIELDS,
        [],
    )
    useless = await analyse_call(
        FakeLLM("I cannot help with that."), "Caller: hi", DISPOSITIONS, FIELDS, []
    )
    assert useful.analysis.disposition == "interested"
    assert (useful.prompt_tokens, useful.cached_tokens, useful.completion_tokens) == (900, 100, 60)
    assert useless.analysis is None and useless.prompt_tokens == 900


async def test_a_failing_model_is_swallowed():
    assert (
        await analyse_call(FakeLLM("", fail=True), "Caller: hi", DISPOSITIONS, FIELDS, []) is None
    )
