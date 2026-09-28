/**
 * Requests to customer-supplied URLs, from inside the platform's network.
 *
 * Webhook endpoints and knowledge-base URLs are typed in by customers, and the
 * control plane fetches them from where it runs -- next to the database, the
 * cache and the cloud metadata service. This is the TypeScript counterpart of
 * the worker's `ssrf.py`, with the same layers:
 *
 * 1. The URL's shape is checked (`urlProblem`): https, a normal port, a
 *    hostname rather than an address.
 * 2. The hostname is resolved here, every address it returns must be public,
 *    and the connection is made to the address that was checked. The custom
 *    `lookup` is the pin: the socket connects to what it returns, while TLS
 *    still verifies the certificate against the hostname.
 * 3. Redirects are not followed.
 * 4. Network egress policy on the host, which is deployment's job and the
 *    one that saves you when the three above have a bug.
 */

import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

import { urlProblem } from "./tools";

export class UnsafeTarget extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTarget";
  }
}

// --- which addresses are public -----------------------------------------------

function v4ToInt(address: string): number {
  return address.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this host"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function v4Blocked(address: string): boolean {
  const ip = v4ToInt(address);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ip & mask) === (v4ToInt(base) & mask);
  });
}

/** An IPv6 address as eight 16-bit groups, `::` and embedded IPv4 expanded. */
function v6Groups(address: string): number[] {
  let text = address.toLowerCase().split("%")[0]!;
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    text = text.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const fill = tail === undefined ? [] : new Array(8 - left.length - right.length).fill(0);
  return [...left, ...fill, ...right];
}

function v6Blocked(address: string): boolean {
  const g = v6Groups(address);
  if (g.length !== 8 || g.some((n) => Number.isNaN(n))) return true;
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  // An IPv4 address wearing IPv6 clothes is judged as the IPv4 address it is.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return v4Blocked(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x100 && g.slice(1, 4).every((n) => n === 0)) return true; // discard
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Whether an address is on the public internet. Anything unparseable is not. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !v4Blocked(address);
  if (kind === 6) return !v6Blocked(address);
  return false;
}

/**
 * Resolves a name and returns the addresses, refusing if any is not public.
 *
 * *Every* answer has to be public, not just the first: a name that answers
 * with one public and one private address is a rebinding attempt.
 */
export async function resolvePublic(hostname: string): Promise<Array<{ address: string; family: number }>> {
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new UnsafeTarget(`could not resolve ${hostname}: ${(error as Error).message}`);
  }
  if (answers.length === 0) throw new UnsafeTarget(`${hostname} resolved to nothing`);
  for (const answer of answers) {
    if (!isPublicAddress(answer.address)) {
      throw new UnsafeTarget(`${hostname} resolves to ${answer.address}, which is not a public address`);
    }
  }
  return answers;
}

// --- making the request -------------------------------------------------------

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface SafeRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** The most of the body that is read; the rest is discarded. */
  maxBytes?: number;
}

/**
 * Makes one request to a customer URL, pinned to an address that was checked.
 *
 * A redirect is returned as the 3xx it is, never followed: a permitted URL
 * must not be able to hand off to a forbidden one.
 */
export async function safeRequest(url: string, options: SafeRequest = {}): Promise<SafeResponse> {
  const problem = urlProblem(url);
  if (problem) throw new UnsafeTarget(`the URL ${problem}`);

  const target = new URL(url);
  const [pinned] = await resolvePublic(target.hostname);
  const maxBytes = options.maxBytes ?? 256 * 1024;

  return new Promise<SafeResponse>((resolve, reject) => {
    const request = https.request(
      target,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        timeout: options.timeoutMs ?? 10_000,
        // The pin. Whatever the resolver would say now, the socket connects
        // to the address checked above.
        lookup: ((_host: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (opts?.all) callback(null, [{ address: pinned!.address, family: pinned!.family }]);
          else callback(null, pinned!.address, pinned!.family);
        }) as unknown as import("node:net").LookupFunction,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < maxBytes) chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
