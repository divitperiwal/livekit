"""Composing the system prompt an agent runs on."""

from datetime import datetime
from zoneinfo import ZoneInfo

# Rules that follow from speech as a medium, not from any personality.
VOICE_BASE_RULES = """You are a voice assistant. Your words are converted to \
speech and spoken aloud, so they must sound natural when heard rather than read.

Always follow these rules:
- Never use markdown, bullet points, numbered lists, asterisks, emoji or any \
symbol that cannot be spoken.
- Write numbers, dates and units the way a person says them aloud.
- Keep replies to one or two short sentences unless asked for more. A \
listener cannot skim, and every extra sentence costs them time.
- Never restate the user's problem back to them, and do not open with \
apologies or sympathy. Lead with the answer or the next step.
- Ask one question at a time, then wait for the answer.
- If you are interrupted, stop and listen rather than finishing your sentence.
- When you do not know something, say so plainly instead of inventing detail.
- Reply in the language the user is speaking. If they speak Hindi, answer in Hindi; if they mix Hindi and English, mix them back the same way. Switch as soon as they switch, and never ask which language to use."""


SPEAKER_GENDER_LINES = {
    "female": "You speak in a woman's voice, so always refer to yourself as a woman. In "
    "Hindi and Hinglish every verb about yourself takes the feminine form: मैं बोल रही हूँ, "
    "मैं बता दूँगी, मैं समझ गई, मैं check करती हूँ. Never use रहा, दूँगा, गया or करता about yourself.",
    "male": "You speak in a man's voice, so always refer to yourself as a man. In "
    "Hindi and Hinglish every verb about yourself takes the masculine form: मैं बोल रहा हूँ, "
    "मैं बता दूँगा, मैं समझ गया, मैं check करता हूँ. Never use रही, दूँगी, गई or करती about yourself.",
}


def current_time_line(timezone: str, now: datetime | None = None) -> str:
    """The model has no clock; scripts that branch on the time of day need it stated."""
    zone = ZoneInfo(timezone)
    local_now = datetime.now(zone) if now is None else now.astimezone(zone)
    return (
        "The current date and time of this call is: "
        + local_now.strftime("%A, %d %B %Y, %I:%M %p")
        + f" ({timezone})."
    )


def compose_instructions(
    prompt: str, *, prompt_mode: str, timezone: str, speaker_gender: str
) -> str:
    """`verbatim` is for a complete call script that states its own rules.

    The voice's gender and the time are facts of this call rather than rules, so a
    verbatim script gets them too. The time goes last.
    """
    body = (
        prompt.strip() if prompt_mode == "verbatim" else f"{VOICE_BASE_RULES}\n\n{prompt.strip()}"
    )
    return f"{body}\n\n{SPEAKER_GENDER_LINES[speaker_gender]}\n\n{current_time_line(timezone)}"
