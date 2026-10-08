import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Guarantee 5: every customer-supplied URL is fetched only after its address is checked.
 * The host is resolved once, every address must be public, and the connection is pinned to
 * the checked address (no second lookup an attacker could change). TLS still verifies the
 * hostname. Redirects are never followed.
 */

export class BlockedUrlError extends Error {}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function isBlockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  return BLOCKED_IPV4.some(([network, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4Number(network);
    return value >= start && value < start + size;
  });
}

/** Eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split("%")[0]!;
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const value = ipv4Number(v4[1]!);
    text =
      text.slice(0, -v4[1]!.length) +
      `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array(tail === undefined ? 0 : missing).fill("0"), ...tailGroups].map(
    (group) => parseInt(group || "0", 16),
  );
}

function isBlockedIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const [first, second] = groups as [number, number];
  const allZero = (from: number, to: number) =>
    groups.slice(from, to).every((group) => group === 0);
  const embeddedIpv4 = () =>
    `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;

  const isUnspecifiedOrLoopback = allZero(0, 7) && groups[7]! <= 1; // :: and ::1
  const isIpv4Mapped = allZero(0, 5) && groups[5] === 0xffff; // ::ffff:a.b.c.d
  const isNat64 = first === 0x64 && second === 0xff9b && allZero(2, 6); // 64:ff9b::a.b.c.d

  if (isUnspecifiedOrLoopback) return true;
  if (isIpv4Mapped || isNat64) return isBlockedIpv4(embeddedIpv4());
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  return false;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family === 6) return !isBlockedIpv6(address);
  return false;
}

export type SafePostOptions = {
  timeoutMs: number;
  resolve?: Resolver;
  /** Tests only: lets a loopback test server through the address check. */
  allowAddress?: (address: string) => boolean;
  /** Tests only: plain http to a local test server. Production URLs must be https. */
  allowHttp?: boolean;
};

/** Checks a URL the way delivery will, without sending anything. */
export async function checkedAddress(
  url: URL,
  options: Pick<SafePostOptions, "resolve" | "allowAddress" | "allowHttp">,
) {
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    throw new BlockedUrlError("only https URLs are allowed");
  }
  if (url.username || url.password) {
    throw new BlockedUrlError("URLs with credentials are not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses: ResolvedAddress[] = isIP(host)
    ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await (options.resolve ?? systemResolver)(host);
  if (addresses.length === 0) throw new BlockedUrlError(`${host} does not resolve`);
  const allowed = options.allowAddress ?? isPublicAddress;
  const blocked = addresses.find(({ address }) => !allowed(address));
  if (blocked) {
    throw new BlockedUrlError(`${host} resolves to a non-public address (${blocked.address})`);
  }
  return addresses[0]!;
}

/** POSTs `body` to a checked, pinned address. Resolves with the status; never follows redirects. */
export async function safePost(
  urlText: string,
  body: string,
  headers: Record<string, string>,
  options: SafePostOptions,
): Promise<{ status: number }> {
  const url = new URL(urlText);
  const pinned = await checkedAddress(url, options);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        // Pins the connection to the address checked above; Bun asks for the `all` form.
        lookup: ((
          _hostname: string,
          lookupOptions: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) =>
          lookupOptions?.all
            ? callback(null, [pinned])
            : callback(null, pinned.address, pinned.family)) as never,
      },
      (response) => {
        response.resume(); // the body is not needed; drain it so the socket closes
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
        response.on("error", reject);
      },
    );
    request.setTimeout(options.timeoutMs, () =>
      request.destroy(new Error(`no answer within ${options.timeoutMs} ms`)),
    );
    request.on("error", reject);
    request.end(body);
  });
}
