"""A caller who has gone quiet is checked on, then said goodbye to.

A line left open on silence costs carrier minutes and speech-to-text for nothing, and a
caller who put the phone down without hanging up is common on mobiles. The session marks
the caller "away" after `silence_timeout` seconds of silence on both sides.
"""

from enum import Enum

SILENCE_CHECK_INSTRUCTIONS = (
    "The caller has gone quiet. Briefly check they are still there, in the language of the "
    "conversation. One short sentence."
)
SILENCE_GOODBYE_INSTRUCTIONS = (
    "The caller has not answered. Say a short goodbye, in the language of the conversation, "
    "and nothing else."
)


class SilenceAction(Enum):
    CHECK = "check"
    GOODBYE = "goodbye"


class SilenceWatch:
    """`max_checks` of 0 never hangs up on silence."""

    def __init__(self, max_checks: int) -> None:
        self._max_checks = max_checks
        self._checks = 0

    def caller_spoke(self) -> None:
        self._checks = 0

    def caller_away(self) -> SilenceAction | None:
        if self._max_checks == 0:
            return None
        if self._checks < self._max_checks:
            self._checks += 1
            return SilenceAction.CHECK
        return SilenceAction.GOODBYE
