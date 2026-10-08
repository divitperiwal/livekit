"""`uv run telephony setup` provisions the LiveKit side of the Plivo bridge and prints what
to configure on Plivo. `uv run telephony call +91...` places one outbound call.

The call goes through the production path: the worker is dispatched with "place this
call" metadata and dials itself, with answering-machine detection, exactly as the dialer
does. The worker must be running (`uv run agent dev`) under TELEPHONY_AGENT_NAME.
"""

import argparse
import asyncio
import json
import os
import secrets
import sys

from dotenv import load_dotenv
from livekit import api

from automitra_worker.telephony.provisioning import provision
from automitra_worker.telephony.settings import TelephonyConfigError, TelephonySettings


def livekit_sip_host(livekit_url: str) -> str:
    """LiveKit Cloud's per-project SIP host, derived from the project URL."""
    host = (
        livekit_url.removeprefix("wss://")
        .removeprefix("ws://")
        .removeprefix("https://")
        .rstrip("/")
    )
    subdomain = host.split(".", 1)[0]
    if host.endswith("livekit.cloud") and subdomain:
        return f"{subdomain}.sip.livekit.cloud"
    return "<your LiveKit SIP host>"


def place_call_metadata(to_number: str, from_number: str | None, agent_id: str | None) -> str:
    metadata: dict[str, object] = {
        "placeCall": True,
        "toNumber": to_number,
        "direction": "outbound",
    }
    if from_number:
        metadata["fromNumber"] = from_number
    if agent_id:
        metadata["agentId"] = agent_id
    return json.dumps(metadata)


async def setup() -> None:
    settings = TelephonySettings.from_environment()
    settings.require_enabled()
    for warning in settings.warnings:
        print(f"  note: {warning}\n")
    print(f"Provisioning LiveKit SIP for Plivo\n  {settings.describe()}\n")
    async with api.LiveKitAPI() as livekit_api:
        result = await provision(livekit_api, settings)
    print(f"  inbound trunk   {result.inbound.sip_trunk_id}")
    print(f"  outbound trunk  {result.outbound.sip_trunk_id}")
    print(
        f"  dispatch rule   {result.dispatch.sip_dispatch_rule_id} (one room per call, {settings.room_prefix}-*)"
    )

    username = settings.auth_username or "<not set>"
    print("\nNow configure Plivo (console.plivo.com > Zentrunk):")
    print("  1. An OUTBOUND trunk (Plivo -> LiveKit), so your numbers reach the agent:")
    print(f"       Primary SIP URI:  {livekit_sip_host(os.getenv('LIVEKIT_URL', ''))}")
    print(f"       Credentials:      username {username} with PLIVO_SIP_PASSWORD")
    print("  2. Point each number at that trunk:")
    for number in settings.numbers:
        print(f"       {number}")
    print("  3. An INBOUND trunk (LiveKit -> Plivo) with the same credentials, for outbound calls.")
    print(f"     LiveKit sends to {settings.outbound_address}")


async def call(to_number: str, from_number: str | None, agent_id: str | None) -> None:
    settings = TelephonySettings.from_environment()
    settings.require_enabled()
    if not to_number.startswith("+"):
        raise TelephonyConfigError(
            f"The number to call must be E.164, like +911234567890. Got {to_number!r}."
        )
    if from_number and from_number not in settings.numbers:
        raise TelephonyConfigError(
            f"Caller ID {from_number} is not one of your Plivo numbers ({', '.join(settings.numbers)})."
        )
    if not settings.agent_name:
        raise TelephonyConfigError(
            "Set TELEPHONY_AGENT_NAME: the call is placed by dispatching that worker."
        )
    room_name = f"{settings.room_prefix}-{secrets.token_hex(4)}"
    async with api.LiveKitAPI() as livekit_api:
        await livekit_api.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=settings.agent_name,
                room=room_name,
                metadata=place_call_metadata(
                    to_number, from_number or settings.numbers[0], agent_id
                ),
            )
        )
    print(f"Dispatched {settings.agent_name} into {room_name} to call {to_number}.")
    print("The worker dials, listens for an answering machine, then greets. Watch its log.")


def main() -> None:
    load_dotenv(".env.local")
    load_dotenv()
    parser = argparse.ArgumentParser(
        prog="telephony", description="Bridge Plivo numbers to the voice worker."
    )
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("setup", help="create or update the LiveKit SIP trunks and dispatch rule")
    call_parser = commands.add_parser("call", help="place one outbound call through the worker")
    call_parser.add_argument("to", help="number to call, E.164, e.g. +911234567890")
    call_parser.add_argument(
        "--from", dest="from_number", help="caller ID; defaults to the first PLIVO_PHONE_NUMBERS"
    )
    call_parser.add_argument("--agent-id", help="multi-tenant mode: the agent to call as")
    arguments = parser.parse_args()
    try:
        if arguments.command == "call":
            asyncio.run(call(arguments.to, arguments.from_number, arguments.agent_id))
        else:
            asyncio.run(setup())
    except TelephonyConfigError as error:
        print(f"\n{error}\n", file=sys.stderr)
        sys.exit(1)
    except api.TwirpError as error:
        print(f"\nLiveKit rejected the request: {error}\n", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
