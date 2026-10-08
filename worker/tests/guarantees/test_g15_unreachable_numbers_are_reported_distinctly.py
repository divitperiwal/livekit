"""Guarantee 15, worker half: an unreachable number (SIP 404 / 410 / 484 / 604) is reported
so the dialer can tell it apart from busy or unanswered, and never retry it. The dialer
half (no retry; a lost dispatch frees its slot after 5 minutes) is tested in the API."""

import pytest
from cost_fakes import MODELS
from livekit.api.twirp_client import SipCallError

from automitra_worker.cost.call_budget import CallBudget
from automitra_worker.cost.usage_meter import UsageMeter
from automitra_worker.reporting.call_outcome import CallOutcome
from automitra_worker.reporting.finalize import finalize_request
from automitra_worker.telephony.outbound import classify_dial_failure, is_unreachable


def finalized_after_dial_failure(sip_code: int):
    outcome = CallOutcome()
    outcome.status, outcome.end_reason = classify_dial_failure(
        SipCallError(
            "unavailable", "call failed", status=503, metadata={"sip_status_code": str(sip_code)}
        )
    )
    outcome.answered = False
    return finalize_request(
        outcome=outcome,
        budget=CallBudget(limit_inr=0, **MODELS),
        close_reason=None,
        duration_seconds=12,
        latency=None,
        usage=UsageMeter(),
    )


@pytest.mark.parametrize("sip_code", [404, 410, 484, 604])
def test_an_unreachable_number_reaches_the_api_marked_as_such(sip_code):
    request = finalized_after_dial_failure(sip_code)
    assert request.status == "failed" and is_unreachable(request.end_reason)
    assert request.usage is None and request.duration_seconds == 0


@pytest.mark.parametrize("sip_code", [486, 603, 480, 487, 503])
def test_busy_unanswered_and_other_failures_are_never_mistaken_for_unreachable(sip_code):
    assert not is_unreachable(finalized_after_dial_failure(sip_code).end_reason)
