"""An agent ready to run one call: its validated config plus its composed prompt and greeting."""

import dataclasses
from collections.abc import Mapping
from dataclasses import dataclass

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.agent_config.sarvam_catalog import TTS_SPEAKER_GENDERS
from automitra_worker.pipeline.prompt import compose_instructions
from automitra_worker.pipeline.variables import render


@dataclass(frozen=True)
class RuntimeAgent:
    config: AgentConfigModel
    instructions: str
    greeting: str
    # A label for log lines: the persona in dev mode, the agent's slug once stored.
    name: str

    @classmethod
    def compose(
        cls, config: AgentConfigModel, *, prompt: str, greeting: str, name: str
    ) -> "RuntimeAgent":
        return cls(
            config=config,
            instructions=compose_instructions(
                prompt,
                prompt_mode=config.prompt_mode,
                timezone=config.timezone,
                speaker_gender=TTS_SPEAKER_GENDERS[config.tts_model][config.tts_speaker],
            ),
            greeting=greeting,
            name=name,
        )

    @classmethod
    def from_stored(
        cls,
        stored_config: Mapping[str, object],
        *,
        prompt_mode: str,
        instructions: str,
        greeting: str,
        name: str,
    ) -> "RuntimeAgent":
        """A stored agent version. Its prompt mode is stored beside the prompt it governs,
        so it wins over any copy inside the config."""
        config = AgentConfigModel.from_stored({**stored_config, "promptMode": prompt_mode})
        return cls.compose(config, prompt=instructions, greeting=greeting, name=name)

    def with_variables(self, values: Mapping[str, str]) -> "RuntimeAgent":
        """Applied even with no values, so `{{name|ji}}` renders its default and a bare
        `{{name}}` renders as nothing rather than braces read aloud."""
        return dataclasses.replace(
            self,
            instructions=render(self.instructions, values),
            greeting=render(self.greeting, values),
            config=self.config.model_copy(
                update={"voicemail_message": render(self.config.voicemail_message, values)}
            ),
        )

    def describe(self) -> str:
        config = self.config
        min_delay, max_delay = config.effective_endpointing_delays
        return (
            f"agent={self.name} "
            f"budget={'Rs %.2f/call' % config.budget_inr if config.budget_inr > 0 else 'off'} "
            f"stt={config.stt_model} (mode={config.stt_mode}, lang={config.stt_language}, "
            f"realtime={config.stt_realtime}) "
            f"llm={config.llm_model} "
            f"tts={config.tts_model} (speaker={config.tts_speaker}, lang={config.tts_language}) "
            f"turn_detection={'semantic+vad' if config.use_turn_detector else 'vad-only'} "
            f"vad(min_silence={config.vad_min_silence}s) "
            f"endpointing({min_delay}s-{max_delay}s)"
        )
