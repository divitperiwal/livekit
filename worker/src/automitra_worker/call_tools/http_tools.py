"""The business's own endpoints as tools the model calls mid-call (`httpTools`), such as a
stock check.

The worker never calls them itself: the API holds the account's signing secret, checks the
arguments against the version the call runs, and guards the address. A tool that fails or
does not answer in time is told to the model, which explains it to the caller instead of
going silent.
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from livekit.agents import function_tool
from livekit.agents.llm import RawFunctionTool, ToolError

from automitra_worker.agent_config.model import HttpTool, ToolParameter
from automitra_worker.control_plane.client import ToolArgumentsRefused
from automitra_worker.control_plane.contract import ToolCallResponse

logger = logging.getLogger("automitra.http_tools")

# Silence while the business's system answers sounds like a dropped line.
SAY_YOU_ARE_CHECKING = "Before calling this, tell the caller in a few words that you are checking."
SYSTEM_UNAVAILABLE = (
    "The system did not answer. Tell the caller you could not check right now, and offer to "
    "have someone call them back."
)

# (tool name, arguments, timeout in seconds) -> the API's answer.
ToolSender = Callable[[str, dict[str, Any], float], Awaitable[ToolCallResponse]]


def parameter_schema(parameter: ToolParameter) -> dict[str, Any]:
    if parameter.type == "enum" and parameter.options:
        schema: dict[str, Any] = {"type": "string", "enum": list(parameter.options)}
    elif parameter.type in ("number", "boolean"):
        schema = {"type": parameter.type}
    else:
        schema = {"type": "string"}
    if parameter.description:
        schema["description"] = parameter.description
    return schema


def parameters_schema(tool: HttpTool) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            parameter.name: parameter_schema(parameter) for parameter in tool.parameters
        },
        "required": [parameter.name for parameter in tool.parameters if parameter.required],
    }


def http_tool(tool: HttpTool, send: ToolSender) -> RawFunctionTool:
    async def call_business_system(raw_arguments: dict[str, Any]) -> str:
        try:
            response = await send(tool.name, dict(raw_arguments), tool.timeout)
        except ToolArgumentsRefused as error:
            raise ToolError(f"The arguments were refused: {error}. Correct them and try again.")
        except Exception as error:
            logger.warning("tool %s could not be called: %s", tool.name, error)
            raise ToolError(SYSTEM_UNAVAILABLE) from error
        if not response.ok:
            logger.warning(
                "tool %s failed (%s): %s", tool.name, response.status_code, response.output
            )
            raise ToolError(SYSTEM_UNAVAILABLE)
        return response.output

    return function_tool(
        call_business_system,
        raw_schema={
            "name": tool.name,
            "description": f"{tool.description}\n\n{SAY_YOU_ARE_CHECKING}",
            "parameters": parameters_schema(tool),
        },
    )
