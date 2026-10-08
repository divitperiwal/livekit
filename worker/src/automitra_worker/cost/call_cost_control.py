"""One call's cost limits together: what it used, its per-call budget, and its per-minute
ceiling. The entrypoint feeds it metrics and acts on the stage it reports."""

import time
from collections.abc import Callable

from livekit.agents import metrics

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.cost.call_budget import WARN_INSTRUCTIONS, CallBudget, Stage
from automitra_worker.cost.prices import CostBreakdown, usage_cost
from automitra_worker.cost.rate_ceiling import RATE_INSTRUCTIONS, RateCeiling
from automitra_worker.cost.usage_meter import UsageMeter


class CallCostControl:
    def __init__(
        self,
        config: AgentConfigModel,
        *,
        limit_inr: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._models = {
            "stt_model": config.stt_model,
            "tts_model": config.tts_model,
            "llm_model": config.llm_model,
        }
        self.usage = UsageMeter()
        self.budget = CallBudget(
            limit_inr=limit_inr,
            warn_at=config.budget_warn_at,
            wrap_at=config.budget_wrap_at,
            **self._models,
        )
        self.ceiling = RateCeiling(
            ceiling_inr_per_min=config.effective_max_inr_per_min, **self._models
        )
        self._clock = clock
        self._started_at = clock()

    def validate(self) -> None:
        """Raise before answering if the call could not hold a conversation."""
        self.budget.validate()
        self.ceiling.validate()

    def restart_clock(self) -> None:
        """When an outbound call is answered, so ringing counts against nothing."""
        self._started_at = self._clock()

    def elapsed(self) -> float:
        return self._clock() - self._started_at

    def on_metrics(self, metric: object) -> Stage | None:
        """Take in one metrics event; return the budget stage if this event moved it."""
        self.usage.collect(metric)
        if isinstance(metric, metrics.LLMMetrics):
            self.ceiling.observe_request(
                metric.prompt_tokens, metric.prompt_cached_tokens, metric.completion_tokens
            )
        self.ceiling.observe(self.usage)
        self.ceiling.steer(self.elapsed())

        previous_stage = self.budget.stage
        stage = self.budget.update(self.usage)
        return stage if stage != previous_stage else None

    def steering(self) -> str:
        """Built from both limits each time, so relaxing one never drops the other."""
        notes = []
        if self.budget.stage >= Stage.WARN:
            notes.append(WARN_INSTRUCTIONS)
        if self.ceiling.tightened:
            notes.append(RATE_INSTRUCTIONS)
        return "\n\n".join(notes)

    def cost_so_far(self) -> CostBreakdown:
        return usage_cost(self.usage, **self._models)
