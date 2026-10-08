"""The `/internal/*` contract between the worker and the API, request and response.

Defined here first and exported to `schema/internal-api.schema.json`; the API implements
these shapes. All keys are camelCase on the wire.

    GET  /internal/resolve                 -> ResolveResponse   (402, 403, 404 -> ErrorResponse)
    POST /internal/calls                   OpenCallRequest      -> OpenCallResponse
    POST /internal/calls/{id}/events       AppendEventsRequest  -> AppendEventsResponse
    POST /internal/calls/{id}/finalize     FinalizeCallRequest  -> FinalizeCallResponse

Every write is idempotent: opening on `lkJobId`, events on (call id, `seq`), finalize on
the call id. The worker assigns `seq`, so a retried batch inserts nothing twice.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

INTERNAL_SECRET_HEADER = "x-internal-secret"

CallDirection = Literal["inbound", "outbound"]
CallStatus = Literal[
    "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "voicemail"
]
CallEventType = Literal[
    "user_message",
    "agent_message",
    "tool_call",
    "tool_result",
    "stage_change",
    "transfer",
    "error",
    "amd",
]


class _WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=True, validate_by_alias=True
    )

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True)


class ErrorResponse(_WireModel):
    error: str


class ResolveResponse(_WireModel):
    """Query: `agentVersionId` (pinned), or `agentId` (live version after any experiment
    split), or `number` (the dialled number's assigned agent); plus `orgId` when the job
    carried one. `orgId` is a claim the API checks, never a filter: a mismatch is 403.
    402 means the account or org has no credit."""

    org_id: str
    agent_id: str
    agent_version_id: str
    agent_slug: str
    prompt_mode: Literal["prepend_base_rules", "verbatim"]
    instructions: str = Field(min_length=1)
    greeting: str = Field(min_length=1)
    # The stored camelCase agent config; validated by AgentConfigModel.from_stored.
    config: dict[str, Any] = {}
    record_calls: bool = False
    # What is left to spend, after every account and org check. The call's own budget
    # is capped to it. None when the API places no limit.
    available_inr: float | None = None
    tools: list[dict[str, Any]] = []
    knowledge_base_count: int = 0


class OpenCallRequest(_WireModel):
    org_id: str
    agent_id: str
    # Pins the exact version that ran.
    agent_version_id: str
    lk_room_name: str
    # One call record per LiveKit job: the idempotency key.
    lk_job_id: str
    direction: CallDirection
    from_number: str | None = None
    to_number: str | None = None
    phone_number_id: str | None = None
    answered: bool = True
    variables: dict[str, str] = {}
    campaign_id: str | None = None
    contact_id: str | None = None
    request_id: str | None = None


class OpenCallResponse(_WireModel):
    id: str
    org_id: str


class CallEvent(_WireModel):
    seq: int = Field(ge=1)
    type: CallEventType
    role: Literal["user", "assistant", "tool"] | None = None
    content: str | None = None
    payload: dict[str, Any] = {}
    at: str


class AppendEventsRequest(_WireModel):
    org_id: str
    events: list[CallEvent] = Field(min_length=1)


class AppendEventsResponse(_WireModel):
    inserted: int


class LatencySummary(_WireModel):
    """Seconds the caller waited per reply: end of turn + LLM first token + TTS first byte."""

    turns: int
    p50: float
    p95: float
    max: float
    eou: float
    llm: float
    tts: float
    dominant: Literal["eou", "llm", "tts"]


class UsageReport(_WireModel):
    """Raw usage; the API prices it with the account's rate card."""

    stt_seconds: float
    tts_characters: int
    llm_prompt_tokens: int
    llm_cached_tokens: int
    llm_completion_tokens: int
    stt_model: str
    tts_model: str
    llm_model: str


class QaVerdict(_WireModel):
    criterion: str
    # None: the model gave no clear answer ("unclear").
    passed: bool | None


class CallAnalysis(_WireModel):
    """Written by the model after the call, then checked: a disposition the agent does not
    define, or a field of the wrong type, arrives as null."""

    summary: str | None = Field(default=None, max_length=1000)
    disposition: str | None = None
    fields: dict[str, Any] = {}
    qa: list[QaVerdict] = []


class FinalizeCallRequest(_WireModel):
    status: CallStatus
    end_reason: str | None = None
    # To when the line closed, not to when the post-call work finished.
    duration_seconds: int = Field(ge=0)
    do_not_call: bool = False
    recording_key: str | None = None
    latency: LatencySummary | None = None
    analysis: CallAnalysis | None = None
    # Absent for an unanswered call: nothing worth charging for.
    usage: UsageReport | None = None


class FinalizeCallResponse(_WireModel):
    id: str
    status: CallStatus


CONTRACT_MODELS: tuple[type[BaseModel], ...] = (
    ErrorResponse,
    ResolveResponse,
    OpenCallRequest,
    OpenCallResponse,
    AppendEventsRequest,
    AppendEventsResponse,
    FinalizeCallRequest,
    FinalizeCallResponse,
)
