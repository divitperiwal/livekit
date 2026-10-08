"""Keys the caller presses reach the model as "[keypad: 1 2]".

Keys arrive one at a time; a pause after the last is taken as the end of what the caller
is entering.
"""

import asyncio
from collections.abc import Callable

KEYPAD_SETTLE_SECONDS = 1.5


def keypad_message(digits: list[str]) -> str:
    return f"[keypad: {' '.join(digits)}]"


class KeypadInput:
    def __init__(
        self, deliver: Callable[[str], None], *, settle_seconds: float = KEYPAD_SETTLE_SECONDS
    ) -> None:
        self._deliver = deliver
        self._settle_seconds = settle_seconds
        self._digits: list[str] = []
        self._pending: asyncio.Task[None] | None = None

    def press(self, digit: str) -> None:
        self._digits.append(digit)
        if self._pending is not None:
            self._pending.cancel()
        self._pending = asyncio.create_task(self._deliver_once_settled())

    async def _deliver_once_settled(self) -> None:
        await asyncio.sleep(self._settle_seconds)
        digits, self._digits = self._digits, []
        if digits:
            self._deliver(keypad_message(digits))
