"""Session events turned into call-event rows (`type`, `role`, `content`, `payload`).

Each takes an SDK object and returns its row, or None when there is nothing worth
recording. Finished turns come from `conversation_item_added`, which fires once per turn;
`user_input_transcribed` fires repeatedly with progressively longer partials.
"""

from typing import Any

# A runaway generation must not produce a row too big for the database or a webhook.
MAX_CONTENT_CHARS = 16_000


def conversation_item(item: Any) -> dict[str, Any] | None:
    role = getattr(item, "role", None)
    if role not in ("user", "assistant"):
        return None
    content = _text(getattr(item, "text_content", None) or getattr(item, "content", None))
    if content is None:
        return None
    payload: dict[str, Any] = {"itemId": getattr(item, "id", None)}
    # Many interruptions usually mean endpointing is too eager: invisible from text alone.
    if getattr(item, "interrupted", False):
        payload["interrupted"] = True
    confidence = getattr(item, "transcript_confidence", None)
    if confidence is not None:
        payload["confidence"] = confidence
    return {
        "type": "user_message" if role == "user" else "agent_message",
        "role": role,
        "content": content,
        "payload": payload,
    }


def tool_events(function_calls: list[Any], outputs: list[Any]) -> list[dict[str, Any]]:
    """Separate rows for calls and results: a call with no result is the interesting case,
    a tool that never returned."""
    rows = [
        {
            "type": "tool_call",
            "role": "assistant",
            "content": getattr(call, "name", None),
            "payload": {
                "callId": getattr(call, "call_id", None),
                "name": getattr(call, "name", None),
                "arguments": _text(getattr(call, "arguments", None)),
            },
        }
        for call in function_calls
    ]
    rows += [
        {
            "type": "tool_result",
            "role": "tool",
            "content": _text(getattr(output, "output", None)),
            "payload": {
                "callId": getattr(output, "call_id", None),
                "name": getattr(output, "name", None),
                "isError": bool(getattr(output, "is_error", False)),
            },
        }
        for output in outputs
    ]
    return rows


def transfer_event(
    target: str, number: str, status: str, error: str | None = None
) -> dict[str, Any]:
    """Where the call left the platform; a failed one is a caller who asked for a person
    and did not get one."""
    payload: dict[str, Any] = {"target": target, "number": number, "status": status}
    if error:
        payload["error"] = error
    return {"type": "transfer", "role": None, "content": target, "payload": payload}


def amd_event(category: str, reason: str, transcript: str, delay_seconds: float) -> dict[str, Any]:
    """What answered an outbound call, with what it heard: a misclassified person is only
    diagnosable from what they actually said."""
    return {
        "type": "amd",
        "role": None,
        "content": category,
        "payload": {
            "reason": reason,
            "heard": _text(transcript),
            "delaySeconds": round(delay_seconds, 2),
        },
    }


def error_event(error: Any, source: Any) -> dict[str, Any]:
    """A transcript that just stops is hard to explain later; the failing part says why."""
    return {
        "type": "error",
        "role": None,
        "content": str(error)[:1000] if error else "unknown error",
        "payload": {"source": type(source).__name__ if source else None},
    }


def stage_event(stage: str, spent_inr: float, limit_inr: float) -> dict[str, Any]:
    """Explains a call that ends politely but early."""
    return {
        "type": "stage_change",
        "role": None,
        "content": stage,
        "payload": {"spentInr": round(spent_inr, 4), "limitInr": limit_inr},
    }


def close_reason(event: Any) -> str:
    reason = getattr(event, "reason", None)
    value = getattr(reason, "value", None) or reason
    return str(value) if value else "unknown"


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value
    elif isinstance(value, (list, tuple)):
        # Non-string parts are audio or images, which have no place in a transcript.
        text = " ".join(part for part in value if isinstance(part, str))
    else:
        text = str(value)
    text = text.strip()
    if not text:
        return None
    return text[:MAX_CONTENT_CHARS] + " [truncated]" if len(text) > MAX_CONTENT_CHARS else text
