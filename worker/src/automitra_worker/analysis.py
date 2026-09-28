"""After the call: a summary, a disposition, and the fields a business asked for.

This is what an outbound campaign is actually bought for. Nobody reads two
thousand transcripts; they filter on "interested" and export the callback
times.

It runs once the conversation is over, in the job's ``on_session_end`` hook
(see ``agent.py``), which the SDK gives minutes to finish rather than the
seconds a shutdown callback gets. The phone line has already been hung up by
then, so nobody waits on it. What it produces goes into the same finalize
request as the call's usage, and its tokens are billed with the call.

The model is asked for JSON and its answer is then treated as untrusted
input: every value is checked against what the agent's configuration allows,
and anything that does not fit is dropped rather than stored. A disposition
the business never defined is worse than none, because it silently falls out
of every filter built on the defined ones.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from livekit.agents import llm as lk_llm

from .agent_config_model import AnalysisField

logger = logging.getLogger("automitra.analysis")

ANALYSIS_TIMEOUT_SECONDS = 45.0

# The transcript is cut from the front, not the back, when it is too long: the
# end of a call is where it is decided what happens next.
MAX_TRANSCRIPT_CHARS = 24_000
MAX_SUMMARY_CHARS = 1_000
MAX_STRING_VALUE_CHARS = 500

SYSTEM_PROMPT = (
    "You review phone calls between an AI agent and a caller for a business. "
    "You reply with a single JSON object and nothing else: no prose, no "
    "markdown fences."
)


@dataclass(frozen=True)
class Analysis:
    summary: str | None
    disposition: str | None
    fields: dict[str, Any]
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    # One entry per QA criterion, in the agent's order: whether the call met
    # it, or None when the model gave no clear answer.
    qa: tuple[dict[str, Any], ...] = ()

    def as_payload(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "disposition": self.disposition,
            "fields": self.fields,
            "qa": list(self.qa),
        }


@dataclass
class _Usage:
    prompt: int = 0
    completion: int = 0
    cached: int = 0


def transcript_text(chat_ctx: lk_llm.ChatContext) -> tuple[str, int]:
    """The conversation as plain lines, and how many turns the caller spoke."""
    lines: list[str] = []
    caller_turns = 0
    for item in chat_ctx.items:
        role = getattr(item, "role", None)
        if role not in ("user", "assistant"):
            continue
        text = (getattr(item, "text_content", None) or "").strip()
        if not text:
            continue
        if role == "user":
            caller_turns += 1
        lines.append(f"{'Caller' if role == 'user' else 'Agent'}: {text}")

    text = "\n".join(lines)
    if len(text) > MAX_TRANSCRIPT_CHARS:
        text = "[earlier part of the call omitted]\n" + text[-MAX_TRANSCRIPT_CHARS:]
    return text, caller_turns


def build_prompt(
    transcript: str,
    dispositions: tuple[str, ...],
    fields: tuple[AnalysisField, ...],
    qa_criteria: tuple[str, ...] = (),
) -> str:
    field_lines = []
    for f in fields:
        kind = f.type
        if f.type == "enum" and f.options:
            kind = "one of: " + ", ".join(json.dumps(o, ensure_ascii=False) for o in f.options)
        elif f.type == "enum":
            kind = "string"
        field_lines.append(f'- "{f.name}" ({kind}): {f.description or "as stated in the call"}')

    shape = {
        "summary": "two or three sentences in English: who called, what they wanted, what was agreed",
        "disposition": "exactly one of the dispositions listed below",
        "fields": {f.name: "…" for f in fields},
    }
    if qa_criteria:
        shape["qa"] = {str(i): "true or false" for i in range(1, len(qa_criteria) + 1)}
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
            *(f'- "{i}": {c}' for i, c in enumerate(qa_criteria, start=1)),
        ]
    parts += ["", "The call:", transcript]
    return "\n".join(parts)


def _extract_json(raw: str) -> dict[str, Any] | None:
    """The first JSON object in the reply, allowing for fences or chatter around it."""
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _match(value: Any, allowed: tuple[str, ...] | list[str]) -> str | None:
    """The allowed label ``value`` names, ignoring case and spacing."""
    if not isinstance(value, str):
        return None
    wanted = re.sub(r"[\s-]+", "_", value.strip().lower())
    for label in allowed:
        if re.sub(r"[\s-]+", "_", label.lower()) == wanted:
            return label
    return None


def _coerce(field_def: AnalysisField, value: Any) -> Any:
    """A value of the field's type, or None when the reply's value is not one."""
    if value is None:
        return None
    if field_def.type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in ("yes", "true", "haan", "ha"):
            return True
        if isinstance(value, str) and value.strip().lower() in ("no", "false", "nahi", "nahin"):
            return False
        return None
    if field_def.type == "number":
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            cleaned = re.sub(r"[,\s₹]|rs\.?|inr", "", value.strip().lower())
            try:
                number = float(cleaned)
            except ValueError:
                return None
            return int(number) if number.is_integer() else number
        return None
    if field_def.type == "enum" and field_def.options:
        return _match(value, field_def.options)
    if isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    return text[:MAX_STRING_VALUE_CHARS] or None


def parse_qa(body: dict[str, Any], criteria: tuple[str, ...]) -> tuple[dict[str, Any], ...]:
    """The QA verdicts, one per criterion, with anything unclear left as None."""
    answers = body.get("qa")
    answers = answers if isinstance(answers, dict) else {}
    out = []
    for i, criterion in enumerate(criteria, start=1):
        value = answers.get(str(i))
        if isinstance(value, str):
            value = {"true": True, "false": False}.get(value.strip().lower())
        out.append({"criterion": criterion, "passed": value if isinstance(value, bool) else None})
    return tuple(out)


def parse(
    raw: str, dispositions: tuple[str, ...], fields: tuple[AnalysisField, ...]
) -> tuple[str | None, str | None, dict[str, Any]] | None:
    """Check a reply against the configuration. None when it is not JSON at all."""
    body = _extract_json(raw)
    if body is None:
        return None

    summary = body.get("summary")
    summary = summary.strip()[:MAX_SUMMARY_CHARS] if isinstance(summary, str) and summary.strip() else None
    disposition = _match(body.get("disposition"), dispositions)

    values = body.get("fields")
    values = values if isinstance(values, dict) else {}
    out = {f.name: _coerce(f, values.get(f.name)) for f in fields}
    return summary, disposition, out


async def analyse(
    model: lk_llm.LLM,
    transcript: str,
    dispositions: tuple[str, ...],
    fields: tuple[AnalysisField, ...],
    qa_criteria: tuple[str, ...] = (),
    *,
    timeout: float = ANALYSIS_TIMEOUT_SECONDS,
) -> Analysis | None:
    """Ask the model about the call. None if it failed or answered nonsense.

    Failure is logged and swallowed: the call record is worth more without an
    analysis than not written at all.
    """
    chat = lk_llm.ChatContext.empty()
    chat.add_message(role="system", content=SYSTEM_PROMPT)
    chat.add_message(role="user", content=build_prompt(transcript, dispositions, fields, qa_criteria))

    usage = _Usage()

    async def run() -> str:
        text = ""
        async with model.chat(chat_ctx=chat) as stream:
            async for chunk in stream:
                if chunk.delta and chunk.delta.content:
                    text += chunk.delta.content
                if chunk.usage:
                    usage.prompt = chunk.usage.prompt_tokens
                    usage.completion = chunk.usage.completion_tokens
                    usage.cached = chunk.usage.prompt_cached_tokens
        return text

    try:
        raw = await asyncio.wait_for(run(), timeout)
    except Exception as exc:
        logger.warning("call analysis failed: %s", exc)
        return None

    parsed = parse(raw, dispositions, fields)
    if parsed is None:
        logger.warning("call analysis was not JSON: %r", raw[:200])
        # The tokens were still spent, so they are still reported.
        return Analysis(None, None, {}, usage.prompt, usage.completion, usage.cached)

    summary, disposition, values = parsed
    qa = parse_qa(_extract_json(raw) or {}, qa_criteria)
    return Analysis(summary, disposition, values, usage.prompt, usage.completion, usage.cached, qa)
