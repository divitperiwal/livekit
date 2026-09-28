"""Filling ``{{placeholders}}`` in a prompt, a greeting or a tool response.

An outbound call is only personal if the agent knows who it is calling: the
name, the order, the amount due. Those arrive per call -- from a campaign
contact's row, or from whoever dispatched the job -- as a flat mapping of
strings, and are substituted into the agent's text before the call starts.

The syntax is deliberately small:

    {{name}}             the value, or nothing if it was not supplied
    {{name|there}}       the value, or "there" if it was not supplied
    {{order.total}}      a dotted path, for JSON a tool returned

A missing value renders as its default or as nothing, never as the literal
placeholder. An agent that says "Hello, curly-brace name" out loud is worse
than one that says "Hello".

Substitution is a single pass. A value that itself contains ``{{...}}`` is
inserted as text and not expanded again, so a contact whose name was typed as
``{{secret}}`` cannot pull another variable into the prompt.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger("automitra.variables")

# A name is letters, digits, underscores and dots; the default runs to the
# closing braces. Whitespace inside the braces is tolerated, since people type
# `{{ name }}` as often as `{{name}}`.
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|([^}]*))?\}\}")

# A value is a caller's name or an order number, not a document. Anything
# longer is almost certainly a mistake, and it all goes into the system prompt
# on every turn of the call -- which is paid for by the token.
MAX_VALUE_CHARS = 500
MAX_VARIABLES = 100


def clean(raw: Any) -> dict[str, str]:
    """Reduce whatever arrived on the job to a flat mapping of short strings.

    Metadata is written by the control plane but read here without trusting
    its shape: a nested object, a number or a null all have to become
    something that can be spoken, or be dropped.
    """
    if not isinstance(raw, Mapping):
        return {}

    out: dict[str, str] = {}
    for key, value in raw.items():
        if len(out) >= MAX_VARIABLES:
            logger.warning("more than %d variables; ignoring the rest", MAX_VARIABLES)
            break
        if not isinstance(key, str) or not key.strip():
            continue
        if value is None:
            continue
        if isinstance(value, bool):
            text = "yes" if value else "no"
        elif isinstance(value, (str, int, float)):
            text = str(value)
        else:
            # A structure is kept as JSON rather than dropped: the model can
            # read it, and dropping it silently is harder to debug.
            text = json.dumps(value, ensure_ascii=False)
        text = text.strip()
        if len(text) > MAX_VALUE_CHARS:
            text = text[:MAX_VALUE_CHARS]
        out[key.strip()] = text
    return out


def _lookup(data: Any, path: str) -> Any:
    """Follow a dotted path through dicts and lists. None when it leads nowhere."""
    current = data
    for part in path.split("."):
        if isinstance(current, Mapping):
            if part not in current:
                return None
            current = current[part]
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def render(template: str, values: Mapping[str, Any]) -> str:
    """Substitute every placeholder in one pass.

    ``values`` may be the flat mapping from :func:`clean`, where a key can
    itself contain dots, or parsed JSON to walk by path. A flat key is tried
    first, so a variable literally named ``order.id`` wins over a path.
    """
    missing: list[str] = []

    def substitute(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        value = values.get(name) if isinstance(values, Mapping) else None
        if value is None:
            value = _lookup(values, name)
        if value is None or value == "":
            if default is None:
                missing.append(name)
            return (default or "").strip()
        return _as_text(value)

    rendered = PLACEHOLDER.sub(substitute, template)
    if missing:
        # Logged rather than raised: a missing name is a data problem the call
        # can survive, and the log line is where someone will look for it.
        logger.warning("no value for %s; rendered as empty", ", ".join(sorted(set(missing))))
    return rendered
