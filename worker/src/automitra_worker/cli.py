"""Cost inspection command: `uv run costs`."""

from __future__ import annotations

import sys

from dotenv import load_dotenv

from .config import AgentConfig
from .costs import CallProfile, estimate

# Sarvam charges one rate per component regardless of model, so the lever that
# actually moves the bill is the shape of the conversation, not the model list.
# These profiles show that spread.
PROFILES: list[tuple[str, CallProfile]] = [
    ("Agent talks little (25%)", CallProfile(agent_speaking_fraction=0.25)),
    ("Balanced (50%, default)", CallProfile()),
    ("Agent talks a lot (75%)", CallProfile(agent_speaking_fraction=0.75)),
    (
        "Long context (4k tokens/turn)",
        CallProfile(context_tokens_per_turn=4000.0),
    ),
]


def main() -> None:
    # Loaded here rather than at import, so importing this module for its
    # PROFILES table does not read the environment.
    load_dotenv(".env.local")
    load_dotenv()

    profile = CallProfile()
    config = AgentConfig.from_env()

    print("\nYour current configuration")
    print(
        f"  persona={config.persona}  stt_mode={config.stt_mode}  "
        f"speaker={config.tts_speaker}  tts_language={config.tts_language}"
    )
    try:
        breakdown = estimate(
            stt_model=config.stt_model,
            tts_model=config.tts_model,
            llm_model=config.llm_model,
            profile=profile,
        )
    except KeyError as exc:
        print(f"\n  {exc.args[0]}\n")
        sys.exit(1)

    print()
    print(breakdown.render(
        stt=config.stt_model, tts=config.tts_model, llm=config.llm_model
    ))

    print("\n\nHow the conversation shape moves the cost (Rs/min)")
    current = breakdown.total_inr
    for label, alt_profile in PROFILES:
        alt = estimate(
            stt_model=config.stt_model,
            tts_model=config.tts_model,
            llm_model=config.llm_model,
            profile=alt_profile,
        )
        delta = (alt.total_inr / current - 1) * 100 if current else 0.0
        marker = " <- current" if alt.total_inr == current else ""
        print(
            f"  {label:30s} Rs {alt.total_inr:6.3f}/min "
            f"({delta:+6.1f}%){marker}"
        )

    print(
        "\nAssumes the agent speaks "
        f"{profile.agent_speaking_fraction:.0%} of the call, "
        f"{profile.turns_per_min:.0f} turns/min, "
        f"{profile.context_tokens_per_turn:.0f} context tokens/turn."
    )
    print(
        "Sarvam list prices, billed in INR. Cached input tokens are cheaper "
        "than assumed here,\nso a long-running call may come in under this. "
        "The Sarvam dashboard is authoritative.\n"
    )


if __name__ == "__main__":
    main()
