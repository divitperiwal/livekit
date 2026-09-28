/**
 * The control plane's guard on customer URLs.
 *
 * The same property as the worker's `ssrf.py` tests: nothing a customer types
 * as a webhook or document URL may reach inside the network. The addresses
 * below are each a way that has been tried.
 */

import { describe, expect, test } from "bun:test";

import { isPublicAddress, resolvePublic, safeRequest, UnsafeTarget } from "./safe-fetch";

describe("which addresses are public", () => {
  test("public addresses are allowed", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.183.14", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect({ ip, public: isPublicAddress(ip) }).toEqual({ ip, public: true });
    }
  });

  test("everything inside, local or reserved is refused", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "64:ff9b::a9fe:a9fe",
      "2001:db8::1",
      // IPv4 inside IPv6, which a naive v6 check waves through.
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "not an address",
    ]) {
      expect({ ip, public: isPublicAddress(ip) }).toEqual({ ip, public: false });
    }
  });

  test("the edges of the private ranges", () => {
    expect(isPublicAddress("172.15.255.255")).toBe(true);
    expect(isPublicAddress("172.32.0.0")).toBe(true);
    expect(isPublicAddress("100.63.255.255")).toBe(true);
    expect(isPublicAddress("100.128.0.0")).toBe(true);
  });
});

describe("requests", () => {
  test("a name that resolves to loopback is refused before connecting", async () => {
    await expect(resolvePublic("localhost")).rejects.toBeInstanceOf(UnsafeTarget);
  });

  test("the URL's shape is checked first", async () => {
    for (const url of ["http://example.com/", "https://127.0.0.1/", "https://[::1]/", "https://example.com:8443/"]) {
      await expect(safeRequest(url)).rejects.toBeInstanceOf(UnsafeTarget);
    }
  });
});
