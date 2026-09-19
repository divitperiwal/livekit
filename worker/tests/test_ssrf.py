"""Keeping customer tool URLs off the private network.

A tool's URL is typed by a customer and fetched by the worker, so without these
checks a tool is a way to read whatever the worker can reach -- most pointedly
the cloud metadata service, where reaching it usually means reaching the
machine's own credentials.

These are table-driven because the interesting cases are all the ways one
address can be written. `127.0.0.1`, `127.1`, `2130706433`, `0x7f000001` and
`017700000001` are the same host to a resolver, and a blocklist that only
understood the first would wave the rest through.
"""

from __future__ import annotations

import pytest

from automitra_worker.ssrf import (
    SSRFBlocked,
    _as_ip_literal,
    check_url,
    is_blocked,
)


# --- the forms one address can take -----------------------------------------


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", "127.0.0.1"),
        # Shorthand: the last part absorbs the remaining bytes.
        ("127.1", "127.0.0.1"),
        ("10.1", "10.0.0.1"),
        # A bare integer.
        ("2130706433", "127.0.0.1"),
        # Hexadecimal.
        ("0x7f000001", "127.0.0.1"),
        # Octal, which a leading zero signals.
        ("017700000001", "127.0.0.1"),
        ("0177.0.0.1", "127.0.0.1"),
    ],
)
def test_obfuscated_addresses_are_recognised(host: str, expected: str) -> None:
    assert _as_ip_literal(host) == expected


@pytest.mark.parametrize(
    "host",
    ["example.com", "api.kbs.co.in", "v2.api.example.com", "hooks.slack.com"],
)
def test_real_hostnames_are_not_mistaken_for_addresses(host: str) -> None:
    """The false-positive side.

    An early version asked `is_blocked` about the hostname itself, which reads
    every domain as unparseable and therefore blocked -- so no tool could reach
    anywhere at all.
    """
    assert _as_ip_literal(host) is None


# --- what counts as private -------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "169.254.169.254",  # cloud metadata, and the reason this exists
        "127.0.0.1",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.1",
        "0.0.0.0",
        "100.64.0.1",  # carrier-grade NAT
        "::1",
        "fc00::1",  # unique local
        "fe80::1",  # link-local
        "::ffff:127.0.0.1",  # IPv4-mapped IPv6
    ],
)
def test_private_addresses_are_blocked(address: str) -> None:
    assert is_blocked(address)


@pytest.mark.parametrize("address", ["1.1.1.1", "8.8.8.8", "2606:4700::1111"])
def test_public_addresses_are_allowed(address: str) -> None:
    assert not is_blocked(address)


def test_an_unparseable_address_is_blocked() -> None:
    """Not knowing what something is, is not a reason to allow it."""
    assert is_blocked("not-an-address")


# --- URL shape --------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/webhooks/lead",
        "https://crm.kbs.co.in:443/lead",
        "https://hooks.slack.com/services/T000/B000/xxx",
    ],
)
def test_a_legitimate_tool_url_is_accepted(url: str) -> None:
    check_url(url)  # must not raise


@pytest.mark.parametrize(
    ("url", "because"),
    [
        ("https://169.254.169.254/latest/meta-data/", "cloud metadata"),
        ("https://127.0.0.1/admin", "loopback"),
        ("https://127.1/admin", "loopback, shorthand"),
        ("https://2130706433/", "loopback, as an integer"),
        ("https://0x7f000001/", "loopback, in hex"),
        ("https://017700000001/", "loopback, in octal"),
        ("https://localhost/", "loopback, by name"),
        ("https://10.0.0.5/internal", "private network"),
        ("https://192.168.1.1/", "private network"),
        ("https://[::1]/", "loopback over IPv6"),
        ("https://[fc00::1]/", "unique local IPv6"),
        ("file:///etc/passwd", "not an http scheme"),
        ("gopher://example.com/", "not an http scheme"),
        ("http://example.com/", "not https"),
        ("https://user:secret@example.com/", "credentials in the host"),
        ("https://example.com:22/", "a port a tool may not use"),
        ("https://example.com:5432/", "a port a tool may not use"),
    ],
)
def test_a_dangerous_url_is_refused(url: str, because: str) -> None:
    with pytest.raises(SSRFBlocked):
        check_url(url)


def test_plain_http_is_allowed_only_when_asked_for() -> None:
    """For a customer testing against something without a certificate."""
    with pytest.raises(SSRFBlocked):
        check_url("http://example.com/hook")
    check_url("http://example.com/hook", require_https=False)


def test_the_refusal_says_what_is_wrong() -> None:
    """Someone typing a URL into a form needs to know which part to change."""
    with pytest.raises(SSRFBlocked, match="https"):
        check_url("http://example.com/")
    with pytest.raises(SSRFBlocked, match="port"):
        check_url("https://example.com:22/")
    with pytest.raises(SSRFBlocked, match="credentials"):
        check_url("https://user:pw@example.com/")
