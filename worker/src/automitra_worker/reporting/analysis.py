"""After the call: a summary, a disposition, the fields the business asked for, and a
verdict on each QA criterion.

Run in the job's session-end hook, which the SDK gives minutes rather than seconds; the
line is already hung up. The model is asked for JSON and its answer is untrusted input:
every value is checked against the agent's config, and anything that does not fit is
dropped. A disposition the business never defined is worse than none, because it falls
out of every filter built on the defined ones.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from livekit.agents import llm as llm_api

from automitra_worker.agent_config.model import AnalysisField
from automitra_worker.control_plane.contract import CallAnalysis, QaVerdict

logger = logging.getLogger("automitra.analysis")

ANALYSIS_TIMEOUT_SECONDS = 45.0
# Cut from the front: the end of a call is where what happens next is decided.
MAX_TRANSCRIPT_CHARS = 24_000
MAX_SUMMARY_CHARS = 1_000
MAX_STRING_VALUE_CHARS = 500
YES_WORDS = {"yes", "true", "haan", "ha"}
NO_WORDS = {"no", "false", "nahi", "nahin"}

SYSTEM_PROMPT = (
    "You review phone calls between an AI agent and a caller for a business. You reply with "
    "a single JSON object and nothing else: no prose, no markdown fences."
)


@dataclass(frozen=True)
class AnalysisResult:
    """`analysis` is None when the reply was not JSON; its tokens were spent and billed anyway."""

    analysis: CallAnalysis | None
    prompt_tokens: int = 0
    cached_tokens: int = 0
    completion_tokens: int = 0


def transcript_text(chat_ctx: llm_api.ChatContext) -> tuple[str, int]:
    """The conversation as plain lines, and how many turns the caller spoke."""
    lines: list[str] = []
    caller_turns = 0
    for item in chat_ctx.items:
        role = getattr(item, "role", None)
        text = (getattr(item, "text_content", None) or "").strip()
        if role not in ("user", "assistant") or not text:
            continue
        caller_turns += role == "user"
        lines.append(f"{'Caller' if role == 'user' else 'Agent'}: {text}")
    text = "\n".join(lines)
    if len(text) > MAX_TRANSCRIPT_CHARS:
        text = "[earlier part of the call omitted]\n" + text[-MAX_TRANSCRIPT_CHARS:]
    return text, caller_turns


def build_prompt(
    transcript: str, dispositions: list[str], fields: list[AnalysisField], qa_criteria: list[str]
) -> str:
    field_lines = []
    for field in fields:
        kind = (
            "one of: "
            + ", ".join(json.dumps(option, ensure_ascii=False) for option in field.options)
            if field.type == "enum" and field.options
            else "string"
            if field.type == "enum"
            else field.type
        )
        field_lines.append(
            f'- "{field.name}" ({kind}): {field.description or "as stated in the call"}'
        )

    shape: dict[str, Any] = {
        "summary": "two or three sentences in English: who called, what they wanted, what was agreed",
        "disposition": "exactly one of the dispositions listed below",
        "fields": {field.name: "…" for field in fields},
    }
    if qa_criteria:
        shape["qa"] = {str(number): "true or false" for number in range(1, len(qa_criteria) + 1)}
    parts = [
        "Read this call and reply with JSON shaped like:",
        json.dumps(shape, ensure_ascii=False, indent=2),
        "",
        "Dispositions: " + ", ".join(dispositions),
    ]
    if field_lines:
        parts += [
            "",
            "Fields to fill. Use null for any the call does not settle; never guess:",
            *field_lines,
        ]
    if qa_criteria:
        parts += [
            "",
            "Quality checks. For each, true if the agent did it, false if not:",
            *(
                f'- "{number}": {criterion}'
                for number, criterion in enumerate(qa_criteria, start=1)
            ),
        ]
    return "\n".join([*parts, "", "The call:", transcript])


def checked_analysis(
    raw_reply: str, dispositions: list[str], fields: list[AnalysisField], qa_criteria: list[str]
) -> CallAnalysis | None:
    """The reply checked against the agent's config. None when it is not JSON at all."""
    body = _first_json_object(raw_reply)
    if body is None:
        return None
    summary = body.get("summary")
    values = body.get("fields") if isinstance(body.get("fields"), dict) else {}
    return CallAnalysis(
        summary=summary.strip()[:MAX_SUMMARY_CHARS]
        if isinstance(summary, str) and summary.strip()
        else None,
        disposition=_matching_label(body.get("disposition"), dispositions),
        fields={field.name: _typed_value(field, values.get(field.name)) for field in fields},
        qa=_qa_verdicts(body.get("qa"), qa_criteria),
    )


async def analyse_call(
    model: llm_api.LLM,
    transcript: str,
    dispositions: list[str],
    fields: list[AnalysisField],
    qa_criteria: list[str],
    *,
    timeout_seconds: float = ANALYSIS_TIMEOUT_SECONDS,
) -> AnalysisResult | None:
    """None if the model failed: the call record is worth more without an analysis than
    not written at all."""
    chat_ctx = llm_api.ChatContext.empty()
    chat_ctx.add_message(role="system", content=SYSTEM_PROMPT)
    chat_ctx.add_message(
        role="user", content=build_prompt(transcript, dispositions, fields, qa_criteria)
    )
    usage = {"prompt": 0, "cached": 0, "completion": 0}

    async def ask() -> str:
        reply = ""
        async with model.chat(chat_ctx=chat_ctx) as stream:
            async for chunk in stream:
                if chunk.delta and chunk.delta.content:
                    reply += chunk.delta.content
                if chunk.usage:
                    usage.update(
                        prompt=chunk.usage.prompt_tokens,
                        cached=chunk.usage.prompt_cached_tokens,
                        completion=chunk.usage.completion_tokens,
                    )
        return reply

    try:
        raw_reply = await asyncio.wait_for(ask(), timeout_seconds)
    except Exception as error:
        logger.warning("call analysis failed: %r", error)
        return None
    analysis = checked_analysis(raw_reply, dispositions, fields, qa_criteria)
    if analysis is None:
        logger.warning("call analysis was not JSON: %r", raw_reply[:200])
    return AnalysisResult(analysis, usage["prompt"], usage["cached"], usage["completion"])


def _first_json_object(raw: str) -> dict[str, Any] | None:
    """Allowing for fences or chatter around it."""
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _matching_label(value: Any, allowed: list[str]) -> str | None:
    """The allowed label `value` names, ignoring case and spacing."""
    if not isinstance(value, str):
        return None
    wanted = re.sub(r"[\s-]+", "_", value.strip().lower())
    return next(
        (label for label in allowed if re.sub(r"[\s-]+", "_", label.lower()) == wanted), None
    )


def _typed_value(field: AnalysisField, value: Any) -> Any:
    """A value of the field's type, or None."""
    if value is None:
        return None
    if field.type == "boolean":
        if isinstance(value, bool):
            return value
        word = value.strip().lower() if isinstance(value, str) else None
        return True if word in YES_WORDS else False if word in NO_WORDS else None
    if field.type == "number":
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                number = float(re.sub(r"[,\s₹]|rs\.?|inr", "", value.strip().lower()))
            except ValueError:
                return None
            return int(number) if number.is_integer() else number
        return None
    if field.type == "enum" and field.options:
        return _matching_label(value, field.options)
    if isinstance(value, (dict, list)):
        return None
    return str(value).strip()[:MAX_STRING_VALUE_CHARS] or None


def _qa_verdicts(answers: Any, criteria: list[str]) -> list[QaVerdict]:
    answers = answers if isinstance(answers, dict) else {}
    verdicts = []
    for number, criterion in enumerate(criteria, start=1):
        value = answers.get(str(number))
        if isinstance(value, str):
            value = {"true": True, "false": False}.get(value.strip().lower())
        verdicts.append(
            QaVerdict(criterion=criterion, passed=value if isinstance(value, bool) else None)
        )
    return verdicts
