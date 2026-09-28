"""Turning session events into call records.

Kept apart from the session wiring so it can be tested against plain objects
rather than a live agent. Each function takes an SDK event and returns the row
it becomes, or None when there is nothing worth recording.

One thing decides most of the design here: which event carries a *finished*
turn. ``user_input_transcribed`` fires repeatedly as speech is recognised, so
subscribing to it would write the same sentence a dozen times in progressively
more complete forms. ``conversation_item_added`` fires once, when the turn is
final, which is why it is the one used.
"""

from __future__ import annotations

from typing import Any

# Truncation guard for a single turn. Nothing legitimate approaches this; it
# exists so a runaway generation cannot push a single row big enough to be a
# problem for the database or the dashboard.
MAX_CONTENT_CHARS = 16_000


def _text(value: Any) -> str | None:
    """Best-effort text from a chat item's content."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value
    elif isinstance(value, (list, tuple)):
        # Content is a list of parts; the non-string ones are audio or images,
        # which have no place in a transcript.
        text = " ".join(part for part in value if isinstance(part, str))
    else:
        text = str(value)

    text = text.strip()
    if not text:
        return None
    if len(text) > MAX_CONTENT_CHARS:
        return text[:MAX_CONTENT_CHARS] + " [truncated]"
    return text


def conversation_item(item: Any) -> dict[str, Any] | None:
    """A finished conversation turn, as a row.

    Returns None for an item with no speakable text -- an empty turn, or one
    carrying only audio -- since an empty transcript row is noise.
    """
    role = getattr(item, "role", None)
    if role not in ("user", "assistant"):
        return None

    content = _text(getattr(item, "text_content", None) or getattr(item, "content", None))
    if content is None:
        return None

    payload: dict[str, Any] = {"itemId": getattr(item, "id", None)}

    # Whether the agent was cut off mid-sentence. Worth keeping: a call full of
    # interruptions usually means the endpointing is too eager, and that is
    # invisible from the text alone.
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


def tool_events(
    function_calls: list[Any], outputs: list[Any]
) -> list[dict[str, Any]]:
    """The calls an agent made to tools, and what came back.

    Recorded as separate rows rather than one, because a call with no matching
    output is itself the interesting case: it means the tool never returned.
    """
    rows: list[dict[str, Any]] = []

    for call in function_calls:
        rows.append(
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
        )

    for output in outputs:
        rows.append(
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
        )

    return rows


def error_event(error: Any, source: Any) -> dict[str, Any]:
    """Something went wrong during the call.

    Worth a row of its own: a transcript that simply stops is hard to explain
    later, and the reason is usually in whichever component failed.
    """
    return {
        "type": "error",
        "role": None,
        "content": str(error)[:1000] if error else "unknown error",
        "payload": {"source": type(source).__name__ if source else None},
    }


def stage_event(stage: str, spent_inr: float, limit_inr: float) -> dict[str, Any]:
    """The call's budget moved to a new stage.

    Explains a call that ends politely but early, which otherwise looks like
    the agent deciding to hang up for no reason.
    """
    return {
        "type": "stage_change",
        "role": None,
        "content": stage,
        "payload": {"spentInr": round(spent_inr, 4), "limitInr": limit_inr},
    }


def transfer_event(
    target: str, number: str, status: str, error: str | None = None
) -> dict[str, Any]:
    """The agent tried to hand the call to a person.

    Its own row as well as the tool call that caused it, because a transfer is
    where the call left the platform: the minutes after it are the carrier's,
    and a failed transfer is a caller who asked for a person and did not get
    one.
    """
    payload: dict[str, Any] = {"target": target, "number": number, "status": status}
    if error:
        payload["error"] = error
    return {"type": "transfer", "role": None, "content": target, "payload": payload}


def amd_event(category: str, reason: str, transcript: str, delay: float) -> dict[str, Any]:
    """What answered an outbound call: a person, or a machine of some kind.

    Kept with the greeting it heard, since a misclassified person is only
    diagnosable from what they actually said.
    """
    return {
        "type": "amd",
        "role": None,
        "content": category,
        "payload": {
            "reason": reason,
            "heard": _text(transcript),
            "delaySeconds": round(delay, 2),
        },
    }


def close_reason(event: Any) -> str:
    """A short, storable reason a session ended."""
    reason = getattr(event, "reason", None)
    value = getattr(reason, "value", None) or reason
    return str(value) if value else "unknown"
