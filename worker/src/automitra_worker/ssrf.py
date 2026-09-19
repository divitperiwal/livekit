"""Stopping a customer's tool URL from reaching somewhere it should not.

Tools are rows a customer fills in, and the worker makes server-side requests
to whatever URL they give. Left alone that is a way to read anything the worker
can reach: the cloud metadata service and its credentials, a database on a
private subnet, another service that trusts its own network.

Four layers, because each one alone has a hole:

1. The scheme and port are checked when the URL is saved.
2. The hostname is resolved *here*, every address it returns is checked, and
   the connection is made to the address that was checked -- not to a name
   resolved again later. That is what defeats DNS rebinding, where a name
   answers with a public address while it is being validated and a private one
   when it is connected to.
3. Redirects are not followed, so a permitted URL cannot hand off to a
   forbidden one.
4. Network egress policy on the host, which is what saves you when the three
   above have a bug.

This module is layers 1 to 3. The fourth is deployment, and is not optional.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

# Everything that is not the public internet.
#
# The one worth naming is 169.254.0.0/16: on every major cloud that is the
# metadata service, and reaching it usually means reaching the machine's own
# credentials.
BLOCKED_V4 = [
    ipaddress.ip_network(cidr)
    for cidr in (
        "0.0.0.0/8",  # "this host"
        "10.0.0.0/8",  # private
        "100.64.0.0/10",  # carrier-grade NAT
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local, and cloud metadata
        "172.16.0.0/12",  # private
        "192.0.0.0/24",  # IETF protocol assignments
        "192.0.2.0/24",  # documentation
        "192.168.0.0/16",  # private
        "198.18.0.0/15",  # benchmarking
        "198.51.100.0/24",  # documentation
        "203.0.113.0/24",  # documentation
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved
        "255.255.255.255/32",  # broadcast
    )
]

BLOCKED_V6 = [
    ipaddress.ip_network(cidr)
    for cidr in (
        "::/128",  # unspecified
        "::1/128",  # loopback
        "::ffff:0:0/96",  # IPv4-mapped, so a v4 private address cannot sneak in
        "64:ff9b::/96",  # NAT64
        "100::/64",  # discard
        "2001:db8::/32",  # documentation
        "fc00::/7",  # unique local
        "fe80::/10",  # link-local
        "ff00::/8",  # multicast
    )
]

ALLOWED_SCHEMES = {"https", "http"}
ALLOWED_PORTS = {80, 443}


class SSRFBlocked(ValueError):
    """The URL points somewhere a customer tool may not reach."""


@dataclass(frozen=True)
class SafeTarget:
    """A URL that has been checked, and the address it was checked against."""

    url: str
    host: str
    port: int
    ip: str

    @property
    def is_ipv6(self) -> bool:
        return ":" in self.ip


def is_blocked(address: str) -> bool:
    """Whether an IP address is outside the public internet."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        # Unparseable is not a reason to allow it.
        return True

    # `ip_address` accepts decimal and hexadecimal forms ("2130706433",
    # "0x7f000001"), so a blocklist matching on the string would miss them.
    # Comparing networks rather than text is what makes those harmless.
    networks = BLOCKED_V6 if ip.version == 6 else BLOCKED_V4
    if any(ip in network for network in networks):
        return True

    # Belt and braces: the library's own opinion, which covers cases the list
    # above may not have caught.
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def check_url(url: str, *, require_https: bool = True) -> tuple[str, int, str]:
    """Check the shape of a URL. Returns (host, port, scheme).

    Run when a tool is saved as well as when it is called, so a customer is
    told at the point of typing rather than when a call fails.
    """
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise SSRFBlocked(f"could not parse the URL: {exc}") from exc

    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise SSRFBlocked(
            f"{scheme or 'that'} is not a scheme a tool may use; use https"
        )
    if require_https and scheme != "https":
        raise SSRFBlocked("a tool URL must use https")

    # user:password@host is a way to make a URL read as one host while
    # pointing at another.
    if parts.username or parts.password:
        raise SSRFBlocked("a tool URL must not carry credentials in the host")

    host = parts.hostname
    if not host:
        raise SSRFBlocked("the URL has no host")

    try:
        port = parts.port or (443 if scheme == "https" else 80)
    except ValueError as exc:
        raise SSRFBlocked("the URL has an invalid port") from exc

    if port not in ALLOWED_PORTS:
        raise SSRFBlocked(
            f"port {port} is not allowed; a tool may use 80 or 443"
        )

    # A literal address skips DNS, so it is checked here. A *name* cannot be
    # judged yet -- it is checked in `resolve_safely`, against what it actually
    # resolves to. Asking `is_blocked` about a hostname would reject every
    # legitimate domain, since a name is not parseable as an address.
    literal = _as_ip_literal(host)
    if literal is not None and is_blocked(literal):
        raise SSRFBlocked(f"{host} is not a public address")

    # "localhost" and friends never resolve anywhere useful to a customer, and
    # naming them is worth a clearer message than a DNS answer would give.
    if host.lower() in {"localhost", "localhost.localdomain", "ip6-localhost"}:
        raise SSRFBlocked(f"{host} is not a public address")

    return host, port, scheme


def _as_ip_literal(host: str) -> str | None:
    """The address a host names, if it is one written any of the usual ways.

    `ip_address` accepts only dotted quads and IPv6, but a URL host may also be
    a bare integer ("2130706433") or hexadecimal ("0x7f000001"), both of which
    resolvers happily read as 127.0.0.1. Treating those as hostnames would let
    them past this check and rely on DNS to catch them, which is a thinner
    defence than it looks.
    """
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass

    # Everything below covers the forms a resolver accepts but `ip_address`
    # does not. They all mean the same address as a dotted quad, and a
    # blocklist that only understood dotted quads would wave them through.
    parts = host.split(".")
    if not (1 <= len(parts) <= 4) or not all(parts):
        return None

    numbers: list[int] = []
    for part in parts:
        # Each part may be decimal, hexadecimal or octal. Bases are tried
        # explicitly rather than with `int(part, 0)`, which rejects a leading
        # zero that a resolver happily reads as octal.
        if part.lower().startswith("0x"):
            base = 16
        elif part.startswith("0") and len(part) > 1:
            # A leading zero is octal to a resolver, so it has to be octal
            # here too. Reading it as decimal would turn 017700000001
            # (127.0.0.1) into a number too large to be an address, and the
            # host would be waved through as a name.
            base = 8
        else:
            base = 10

        try:
            numbers.append(int(part, base))
        except ValueError:
            return None

    # The last part absorbs whatever is left: "127.1" is 127.0.0.1, and a bare
    # "2130706433" is the whole address.
    *leading, final = numbers
    if any(n > 0xFF for n in leading):
        return None
    remaining_bytes = 4 - len(leading)
    if final >= (1 << (8 * remaining_bytes)):
        return None

    packed = final
    for index, number in enumerate(reversed(leading)):
        packed |= number << (8 * (remaining_bytes + index))

    if 0 <= packed <= 0xFFFFFFFF:
        return str(ipaddress.ip_address(packed))
    return None


def resolve_safely(url: str, *, require_https: bool = True) -> SafeTarget:
    """Check a URL and pin it to one verified address.

    The address returned is the one to connect to. Resolving the name again at
    connection time would reopen the rebinding hole this exists to close.
    """
    host, port, _ = check_url(url, require_https=require_https)

    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise SSRFBlocked(f"could not resolve {host}: {exc}") from exc

    if not infos:
        raise SSRFBlocked(f"{host} resolved to nothing")

    # *Every* answer has to be public, not just the one that would be used. A
    # name answering with one public and one private address is a rebinding
    # attempt, not a coincidence.
    addresses = [info[4][0] for info in infos]
    for address in addresses:
        if is_blocked(address):
            raise SSRFBlocked(
                f"{host} resolves to {address}, which is not a public address"
            )

    return SafeTarget(url=url, host=host, port=port, ip=addresses[0])
