"""Deciding which tenant's agent a job belongs to.

A worker process serves every tenant. Which one a particular call belongs to
arrives with the job, in one of two ways:

``ctx.job.metadata`` carries the identity outright. That is how an outbound
call works -- the control plane put it there when it dispatched -- and how an
inbound call to a provisioned number works, because the number's dispatch rule
declares it.

Failing that, the number that was dialled is read off the SIP participant and
looked up. This is the fallback for a number whose dispatch rule has not been
provisioned yet, or for a catch-all rule.

Resolution failing ends the call. There is no safe default: answering with
whatever configuration happens to be at hand would put a caller through to a
different company's script, and neither of them would know.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from livekit import rtc
from livekit.agents import JobContext

from .config import AgentConfig
from .control_plane import AgentNotResolved, ControlPlane, OutOfCredit, ResolvedAgent

logger = logging.getLogger("automitra.resolve")

# Attributes LiveKit's SIP service stamps onto the participant it creates for
# a phone leg. They are set server-side rather than by this SDK, so they cannot
# be verified from the installed packages -- hence several candidates per value
# and a log line naming what actually arrived when none of them match.
#
# `sip.phoneNumber` is the one the existing telephony code already relies on.
SIP_CALLER_NUMBER_ATTRS = ("sip.phoneNumber", "sip.from", "sip.fromUser")
SIP_DIALLED_NUMBER_ATTRS = (
    "sip.trunkPhoneNumber",
    "sip.to",
    "sip.toUser",
    "sip.calledNumber",
)

# How long to wait for the phone leg to appear before giving up on reading the
# dialled number from it. Only reached on the fallback path.
PARTICIPANT_WAIT_SECONDS = 10.0


class ResolutionFailed(RuntimeError):
    """This call cannot be answered."""


class OutOfCreditFailure(ResolutionFailed):
    """The organisation cannot pay for this call.

    Its own type so the worker can log it as a business refusal rather than a
    fault: nothing is broken, the account is simply empty.
    """


@dataclass(frozen=True)
class JobMeta:
    """Tenant identity carried on the job.

    Everything is optional because a job may legitimately arrive with nothing,
    and because a malformed value must not stop a call that could still be
    resolved by the number that was dialled.
    """

    org_id: str | None = None
    agent_id: str | None = None
    agent_version_id: str | None = None
    direction: str | None = None
    to_number: str | None = None
    from_number: str | None = None
    phone_number_id: str | None = None
    variables: dict[str, str] | None = None

    @property
    def identifies_an_agent(self) -> bool:
        return bool(self.agent_version_id or self.agent_id)

    @classmethod
    def parse(cls, raw: str | None) -> JobMeta:
        """Read job metadata, tolerating anything that is not what we expect.

        Malformed metadata is logged and treated as absent rather than raised:
        the dialled-number fallback may still resolve the call, and failing
        here would turn a recoverable situation into a dropped call.
        """
        if not raw or not raw.strip():
            return cls()
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("job metadata is not JSON; ignoring it")
            return cls()
        if not isinstance(body, dict):
            logger.warning("job metadata is not an object; ignoring it")
            return cls()

        def text(*names: str) -> str | None:
            for name in names:
                value = body.get(name)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return None

        variables = body.get("variables")
        return cls(
            org_id=text("org_id", "orgId"),
            agent_id=text("agent_id", "agentId"),
            agent_version_id=text("agent_version_id", "agentVersionId"),
            direction=text("direction"),
            to_number=text("to_number", "toNumber", "to"),
            from_number=text("from_number", "fromNumber"),
            phone_number_id=text("phone_number_id", "phoneNumberId"),
            variables=variables if isinstance(variables, dict) else None,
        )


@dataclass(frozen=True)
class CallIdentity:
    """Everything known about a call once it has been resolved."""

    config: AgentConfig
    agent: ResolvedAgent
    meta: JobMeta
    direction: str
    caller_number: str | None
    dialled_number: str | None


def _first(attributes: dict[str, str], names: tuple[str, ...]) -> str | None:
    for name in names:
        value = attributes.get(name)
        if value:
            return value
    return None


def sip_numbers(participant: rtc.RemoteParticipant) -> tuple[str | None, str | None]:
    """The caller's number and the number they dialled, if this is a phone leg."""
    attributes = dict(participant.attributes or {})
    return (
        _first(attributes, SIP_CALLER_NUMBER_ATTRS),
        _first(attributes, SIP_DIALLED_NUMBER_ATTRS),
    )


async def _phone_participant(ctx: JobContext) -> rtc.RemoteParticipant | None:
    """Wait briefly for the phone leg, so its number can be read.

    Only used on the fallback path. Returns None rather than raising: the
    caller reports the failure with more context than this function has.
    """
    try:
        return await ctx.wait_for_participant(kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP)
    except Exception:
        return None


async def resolve_call(ctx: JobContext, control_plane: ControlPlane) -> CallIdentity:
    """Work out which agent this call runs as, or refuse to answer it."""
    meta = JobMeta.parse(ctx.job.metadata)

    caller_number = meta.from_number
    dialled_number = meta.to_number

    # The direct path: the job says which agent it is for.
    if meta.identifies_an_agent:
        agent = await _resolve_from_meta(meta, control_plane)
    else:
        # The fallback: find out what number was dialled and look it up. This
        # costs the wait for the phone leg plus a query, which is why a
        # provisioned number carries its identity on the job instead.
        logger.info("job has no agent metadata; resolving by dialled number")
        participant = await _phone_participant(ctx)
        if participant is None:
            raise ResolutionFailed(
                "job carried no agent metadata and no phone participant joined, "
                "so there is nothing to resolve this call against"
            )
        caller_number, dialled_number = sip_numbers(participant)
        if not dialled_number:
            raise ResolutionFailed(
                "job carried no agent metadata and the SIP participant reported "
                f"no dialled number (attributes: {sorted(participant.attributes or {})})"
            )
        agent = await _resolve_by_number(dialled_number, control_plane)

    config = AgentConfig.from_record(agent.as_record())

    direction = meta.direction or ("outbound" if meta.to_number else "inbound")
    logger.info(
        "resolved %s call for org=%s agent=%s version=%s",
        direction,
        agent.org_id,
        agent.agent_slug,
        agent.agent_version_id,
    )
    return CallIdentity(
        config=config,
        agent=agent,
        meta=meta,
        direction=direction,
        caller_number=caller_number,
        dialled_number=dialled_number,
    )


async def _resolve_from_meta(meta: JobMeta, control_plane: ControlPlane) -> ResolvedAgent:
    try:
        return await control_plane.resolve(
            agent_version_id=meta.agent_version_id,
            agent_id=meta.agent_id,
            # Stated as a claim to be checked, not as a filter. The control
            # plane refuses a mismatch, so metadata naming another tenant's
            # agent is an error rather than a way to reach it.
            org_id=meta.org_id,
        )
    except OutOfCredit as exc:
        raise OutOfCreditFailure(str(exc)) from exc
    except AgentNotResolved as exc:
        raise ResolutionFailed(f"the control plane refused this job: {exc}") from exc
    except Exception as exc:
        raise ResolutionFailed(f"could not resolve the agent: {exc}") from exc


async def _resolve_by_number(number: str, control_plane: ControlPlane) -> ResolvedAgent:
    try:
        return await control_plane.resolve(number=number)
    except OutOfCredit as exc:
        raise OutOfCreditFailure(str(exc)) from exc
    except AgentNotResolved as exc:
        raise ResolutionFailed(f"no agent answers {number}: {exc}") from exc
    except Exception as exc:
        raise ResolutionFailed(f"could not resolve {number}: {exc}") from exc
