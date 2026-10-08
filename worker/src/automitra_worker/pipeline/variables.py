"""Filling `{{placeholders}}` in a prompt, a greeting or a tool response.

    {{name}}             the value, or nothing if it was not supplied
    {{name|there}}       the value, or "there" if it was not supplied
    {{order.total}}      a dotted path, for JSON a tool returned

A missing value never renders as braces read aloud. Substitution is a single pass, so a
value containing `{{...}}` cannot pull another variable into the prompt.
"""

import json
import logging
import re
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger("automitra.variables")

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|([^}]*))?\}\}")

# Every value goes into the system prompt on every turn, which is paid for by the token.
MAX_VALUE_CHARS = 500
MAX_VARIABLES = 100


def clean(raw: Any) -> dict[str, str]:
    """Reduce whatever arrived on the job to a flat mapping of short strings."""
    if not isinstance(raw, Mapping):
        return {}

    cleaned: dict[str, str] = {}
    for key, value in raw.items():
        if len(cleaned) >= MAX_VARIABLES:
            logger.warning("more than %d variables; ignoring the rest", MAX_VARIABLES)
            break
        if not isinstance(key, str) or not key.strip() or value is None:
            continue
        text = _as_text(value).strip()[:MAX_VALUE_CHARS]
        cleaned[key.strip()] = text
    return cleaned


def render(template: str, values: Mapping[str, Any]) -> str:
    """A flat key is tried before a dotted path, so a variable named `order.id` wins."""
    missing: list[str] = []

    def substitute(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        value = values.get(name)
        if value is None:
            value = _lookup(values, name)
        if value is None or value == "":
            if default is None:
                missing.append(name)
            return (default or "").strip()
        return _as_text(value)

    rendered = PLACEHOLDER.sub(substitute, template)
    if missing:
        logger.warning("no value for %s; rendered as empty", ", ".join(sorted(set(missing))))
    return rendered


def _lookup(data: Any, path: str) -> Any:
    current = data
    for part in path.split("."):
        if isinstance(current, Mapping):
            if part not in current:
                return None
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
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
