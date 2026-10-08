from cost_fakes import Clock, llm_metric, stt_metric, tts_metric

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.cost.call_budget import WARN_INSTRUCTIONS, Stage
from automitra_worker.cost.call_cost_control import CallCostControl
from automitra_worker.cost.rate_ceiling import RATE_INSTRUCTIONS


def control(limit_inr: float = 10.0, clock: Clock | None = None, **config) -> CallCostControl:
    return CallCostControl(AgentConfigModel(**config), limit_inr=limit_inr, clock=clock or Clock())


def test_it_reports_the_stage_only_when_it_moves():
    cost_control = control(limit_inr=10.0)
    assert cost_control.on_metrics(tts_metric(100)) is None
    assert cost_control.on_metrics(tts_metric(2300)) is Stage.WARN  # Rs 7.20 of Rs 10
    assert cost_control.on_metrics(stt_metric(1.0)) is None
    assert cost_control.on_metrics(tts_metric(700)) is Stage.WRAP


def test_steering_combines_both_limits():
    clock = Clock()
    cost_control = control(limit_inr=10.0, clock=clock)
    assert cost_control.steering() == ""
    cost_control.on_metrics(
        tts_metric(2400)
    )  # over the budget's warn stage and the per-minute rate
    assert WARN_INSTRUCTIONS in cost_control.steering()
    assert RATE_INSTRUCTIONS in cost_control.steering()


def test_model_requests_size_the_room_kept_for_the_next_one():
    cost_control = control()
    floor = cost_control.ceiling.llm_margin_inr
    cost_control.on_metrics(llm_metric(prompt_tokens=30_000, completion_tokens=100))
    assert cost_control.ceiling.llm_margin_inr > floor


def test_the_ceiling_follows_the_agents_config():
    assert control(max_inr_per_min=1.5).ceiling.ceiling_inr_per_min == 1.5
    assert control(max_inr_per_min=0).ceiling.ceiling_inr_per_min == 2.5


def test_restarting_the_clock_discounts_ringing():
    clock = Clock()
    cost_control = control(clock=clock)
    clock.now = 25.0
    cost_control.restart_clock()
    clock.now = 30.0
    assert cost_control.elapsed() == 5.0


def test_cost_so_far_prices_what_was_used():
    cost_control = control()
    cost_control.on_metrics(stt_metric(60.0))
    cost_control.on_metrics(tts_metric(1000))
    assert round(cost_control.cost_so_far().total_inr, 2) == 3.5
