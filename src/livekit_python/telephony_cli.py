"""Telephony commands: `uv run telephony` and `uv run call`.

``telephony`` provisions the LiveKit side of the Plivo bridge and prints what
to configure on Plivo's side. ``call`` places a single outbound call, which is
the quickest honest test that the whole path works.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import secrets
import sys

from dotenv import load_dotenv
from livekit import api

from .telephony import (
    TelephonyConfig,
    TelephonyConfigError,
    dispatch_agent,
    place_call,
    provision,
)

load_dotenv(".env.local")
load_dotenv()


def _sip_uri() -> str:
    """The address Plivo sends calls to.

    LiveKit Cloud exposes a per-project SIP host derived from the project's
    LiveKit URL, so it is reported rather than configured.
    """
    url = os.getenv("LIVEKIT_URL", "")
    host = url.removeprefix("wss://").removeprefix("ws://").rstrip("/")
    subdomain = host.split(".", 1)[0]
    if host.endswith("livekit.cloud") and subdomain:
        return f"{subdomain}.sip.livekit.cloud"
    return "<your LiveKit SIP host>"


def _print_plivo_steps(config: TelephonyConfig) -> None:
    uri = _sip_uri()
    user = config.auth_username or "<not set>"
    print("\nNow configure the Plivo side (console.plivo.com > Zentrunk):")
    print("\n  1. Create an OUTBOUND trunk (Plivo -> LiveKit), so your numbers")
    print("     reach this agent:")
    print(f"       Primary SIP URI:  {uri}")
    print(f"       Credentials list: username {user}, with your")
    print("                         PLIVO_SIP_PASSWORD")
    print("  2. Point each of your numbers at that trunk:")
    for number in config.numbers:
        print(f"       {number}")
    print("\n  3. Create an INBOUND trunk (LiveKit -> Plivo) for outbound calls,")
    print("     with the same credentials list attached. LiveKit will send to")
    print(f"       {config.outbound_address}")
    print(
        "\n  Plivo bills these calls separately from Sarvam and LiveKit -- the\n"
        "  cost lines this project prints do not include per-minute PSTN charges."
    )


async def _provision() -> None:
    config = TelephonyConfig.from_env()
    config.require_enabled()

    for warning in config.warnings:
        print(f"  note: {warning}\n")

    print(f"Provisioning LiveKit SIP for Plivo\n  {config.describe()}\n")
    result = await provision(config)

    print(f"  inbound trunk   {result.inbound.sip_trunk_id}")
    print(f"  outbound trunk  {result.outbound.sip_trunk_id}")
    print(f"  dispatch rule   {result.dispatch.sip_dispatch_rule_id}")
    print(
        f"                  one room per call, named {config.room_prefix}-*"
        + (f", agent {config.agent_name}" if config.agent_name else "")
    )

    _print_plivo_steps(config)


async def _call(to_number: str, from_number: str | None, room: str | None) -> None:
    config = TelephonyConfig.from_env()
    config.require_enabled()

    room_name = room or f"{config.room_prefix}-{secrets.token_hex(4)}"

    # The agent has to be in the room before the callee answers, or they are
    # greeted by silence while the worker spins up.
    if config.agent_name:
        print(f"Dispatching agent {config.agent_name} into {room_name}")
        await dispatch_agent(config.agent_name, room_name)
    else:
        print(
            "  note: TELEPHONY_AGENT_NAME is unset, so this relies on a worker\n"
            "        picking the room up automatically."
        )

    print(f"Calling {to_number} ...")
    participant = await place_call(
        config, to_number, room_name=room_name, from_number=from_number
    )
    print(f"  answered: participant {participant.participant_identity}")
    print(f"  room:     {room_name}")
    print("\nThe call is live. It ends when either side hangs up, or when the")
    print("agent's own budget or duration limits end it.")


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    parser = argparse.ArgumentParser(
        prog="telephony",
        description="Bridge Plivo phone numbers to the LiveKit voice agent.",
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("setup", help="create or update the LiveKit SIP objects")

    call = sub.add_parser("call", help="place an outbound call")
    call.add_argument("to", help="number to call, in E.164 form, e.g. +911234567890")
    call.add_argument(
        "--from",
        dest="from_number",
        help="caller ID; defaults to the first PLIVO_PHONE_NUMBERS entry",
    )
    call.add_argument("--room", help="room name; defaults to a fresh random one")

    args = parser.parse_args()
    command = args.command or "setup"

    try:
        if command == "call":
            asyncio.run(_call(args.to, args.from_number, args.room))
        else:
            asyncio.run(_provision())
    except TelephonyConfigError as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        sys.exit(1)
    except api.TwirpError as exc:
        print(f"\nLiveKit rejected the request: {exc}\n", file=sys.stderr)
        sys.exit(1)


def call_main() -> None:
    """`uv run call <number>` -- a shortcut for `telephony call <number>`."""
    sys.argv.insert(1, "call")
    main()


if __name__ == "__main__":
    main()
