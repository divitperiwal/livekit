"""`uv run costs`: what the dev-mode agent costs per minute, and how the conversation's
shape moves it. Sarvam charges one rate per component whatever the model, so the shape
of the call is the lever, not the model list."""

import sys

from dotenv import load_dotenv

from automitra_worker.agent_config.environment import agent_from_environment
from automitra_worker.cost.estimate import CallProfile, estimate, render_per_minute

PROFILES: list[tuple[str, CallProfile]] = [
    ("Agent talks little (25%)", CallProfile(agent_speaking_fraction=0.25)),
    ("Balanced (50%, default)", CallProfile()),
    ("Agent talks a lot (75%)", CallProfile(agent_speaking_fraction=0.75)),
    ("Long context (4k tokens/turn)", CallProfile(context_tokens_per_turn=4000.0)),
]


def main() -> None:
    load_dotenv(".env.local")
    load_dotenv()
    agent = agent_from_environment()
    config = agent.config
    models = {
        "stt_model": config.stt_model,
        "tts_model": config.tts_model,
        "llm_model": config.llm_model,
    }

    print("\nYour current configuration")
    print(
        f"  agent={agent.name}  stt_mode={config.stt_mode}  speaker={config.tts_speaker}  "
        f"tts_language={config.tts_language}"
    )
    try:
        breakdown = estimate(**models)
    except KeyError as error:
        print(f"\n  {error.args[0]}\n")
        sys.exit(1)
    print()
    print(
        render_per_minute(
            breakdown, stt=config.stt_model, tts=config.tts_model, llm=config.llm_model
        )
    )

    print("\n\nHow the conversation shape moves the cost (Rs/min)")
    for label, profile in PROFILES:
        alternative = estimate(**models, profile=profile)
        change = (
            (alternative.total_inr / breakdown.total_inr - 1) * 100 if breakdown.total_inr else 0.0
        )
        marker = " <- current" if alternative.total_inr == breakdown.total_inr else ""
        print(f"  {label:30s} Rs {alternative.total_inr:6.3f}/min ({change:+6.1f}%){marker}")

    profile = CallProfile()
    print(
        f"\nAssumes the agent speaks {profile.agent_speaking_fraction:.0%} of the call, "
        f"{profile.turns_per_min:.0f} turns/min, {profile.context_tokens_per_turn:.0f} context tokens/turn."
    )
    print(
        f"The per-minute ceiling for this agent is Rs {config.effective_max_inr_per_min:.2f}/min: "
        "replies are cut short rather than let a call cost more."
    )
    print(
        "Sarvam list prices in INR; cached input is cheaper than assumed, so real calls may come in under this.\n"
    )


if __name__ == "__main__":
    main()
