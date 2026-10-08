"""Which tenant's agent a job belongs to.

One worker fleet serves every tenant. The job's metadata names the agent outright (an
outbound call the API dispatched, or a provisioned number's dispatch rule). Failing
that, the dialled number is read off the SIP participant and looked up.

Resolution failing ends the call: there is no safe default, and answering with whatever
configuration is at hand would put a caller through to another company's script.
"""

import json
import logging
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import Protocol

from livekit import rtc

from automitra_worker.agent_config.runtime import RuntimeAgent
from automitra_worker.control_plane.client import CallRefused, OutOfCredit
from automitra_worker.control_plane.contract import CallDirection, ResolveResponse
from automitra_worker.pipeline.variables import clean

logger = logging.getLogger("automitra.resolution")

# Set by LiveKit's SIP service, not this SDK, so several candidates per value.
SIP_CALLER_NUMBER_ATTRIBUTES = ("sip.phoneNumber", "sip.from", "sip.fromUser")
SIP_DIALLED_NUMBER_ATTRIBUTES = ("sip.trunkPhoneNumber", "sip.to", "sip.toUser", "sip.calledNumber")


class ResolutionFailed(RuntimeError):
    """This call cannot be answered."""


class OutOfCreditRefusal(ResolutionFailed):
    """Nothing is broken; the account or org is out of credit."""


class Resolver(Protocol):
    async def resolve(
        self,
        *,
        agent_version_id: str | None = None,
        agent_id: str | None = None,
        number: str | None = None,
        org_id: str | None = None,
    ) -> ResolveResponse: ...


@dataclass(frozen=True)
class JobMetadata:
    """Everything optional: a job may carry nothing, and a malformed value must not stop
    a call the dialled number could still resolve."""

    org_id: str | None = None
    agent_id: str | None = None
    agent_version_id: str | None = None
    direction: CallDirection | None = None
    to_number: str | None = None
    from_number: str | None = None
    phone_number_id: str | None = None
    variables: dict[str, str] | None = None
    # Set by the dialer: the worker places this call itself.
    place_call: bool = False
    campaign_id: str | None = None
    contact_id: str | None = None
    # Set by the public API, so a client can find the call its request became.
    request_id: str | None = None

    @property
    def names_an_agent(self) -> bool:
        return bool(self.agent_version_id or self.agent_id)

    @classmethod
    def parse(cls, raw: str | None) -> "JobMetadata":
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

        direction = text("direction")
        return cls(
            org_id=text("orgId", "org_id"),
            agent_id=text("agentId", "agent_id"),
            agent_version_id=text("agentVersionId", "agent_version_id"),
            direction=direction if direction in ("inbound", "outbound") else None,
            to_number=text("toNumber", "to_number", "to"),
            from_number=text("fromNumber", "from_number"),
            phone_number_id=text("phoneNumberId", "phone_number_id"),
            variables=clean(body.get("variables")) or None,
            place_call=body.get("placeCall") is True or body.get("place_call") is True,
            campaign_id=text("campaignId", "campaign_id"),
            contact_id=text("contactId", "contact_id"),
            request_id=text("requestId", "request_id"),
        )


@dataclass(frozen=True)
class ResolvedCall:
    runtime_agent: RuntimeAgent
    agent: ResolveResponse
    metadata: JobMetadata
    direction: CallDirection
    caller_number: str | None
    dialled_number: str | None


def sip_numbers(attributes: dict[str, str]) -> tuple[str | None, str | None]:
    """The caller's number and the number they dialled, from a phone leg's attributes."""
    return _first(attributes, SIP_CALLER_NUMBER_ATTRIBUTES), _first(
        attributes, SIP_DIALLED_NUMBER_ATTRIBUTES
    )


async def resolve_call(
    metadata: JobMetadata,
    resolver: Resolver,
    wait_for_phone_participant: Callable[[], Awaitable[rtc.RemoteParticipant | None]],
) -> ResolvedCall:
    """`wait_for_phone_participant` is awaited only on the dialled-number path."""
    caller_number, dialled_number = metadata.from_number, metadata.to_number

    if metadata.names_an_agent:
        agent = await _ask(
            resolver,
            "the control plane refused this job",
            agent_version_id=metadata.agent_version_id,
            agent_id=metadata.agent_id,
            org_id=metadata.org_id,
        )
    else:
        logger.info("job names no agent; resolving by the dialled number")
        participant = await wait_for_phone_participant()
        if participant is None:
            raise ResolutionFailed("the job named no agent and no phone participant joined")
        caller_number, dialled_number = sip_numbers(dict(participant.attributes or {}))
        if not dialled_number:
            raise ResolutionFailed(
                "the job named no agent and the phone participant carried no dialled number "
                f"(attributes: {sorted(participant.attributes or {})})"
            )
        agent = await _ask(resolver, f"no agent answers {dialled_number}", number=dialled_number)

    try:
        runtime_agent = RuntimeAgent.from_stored(
            agent.config,
            prompt_mode=agent.prompt_mode,
            instructions=agent.instructions,
            greeting=agent.greeting,
            name=agent.agent_slug,
        )
    except ValueError as error:
        # The API validates configs on save; one failing here means the two validators
        # disagree, which guarantee 17's tests exist to prevent.
        raise ResolutionFailed(
            f"agent version {agent.agent_version_id} has an invalid config: {error}"
        ) from error

    direction = metadata.direction or ("outbound" if metadata.to_number else "inbound")
    logger.info(
        "resolved %s call: org=%s agent=%s version=%s",
        direction,
        agent.org_id,
        agent.agent_slug,
        agent.agent_version_id,
    )
    return ResolvedCall(
        runtime_agent=runtime_agent,
        agent=agent,
        metadata=metadata,
        direction=direction,
        caller_number=caller_number,
        dialled_number=dialled_number,
    )


async def _ask(resolver: Resolver, refusal: str, **query: str | None) -> ResolveResponse:
    try:
        return await resolver.resolve(**query)
    except OutOfCredit as error:
        raise OutOfCreditRefusal(str(error)) from error
    except CallRefused as error:
        raise ResolutionFailed(f"{refusal}: {error}") from error
    except Exception as error:
        raise ResolutionFailed(f"could not resolve the call: {error}") from error


def _first(attributes: dict[str, str], names: tuple[str, ...]) -> str | None:
    for name in names:
        if attributes.get(name):
            return attributes[name]
    return None
