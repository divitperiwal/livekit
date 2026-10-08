import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BlockedUrlError,
  checkedAddress,
  isPublicAddress,
  safePost,
} from "../../src/modules/webhooks/safe-fetch";

describe("guarantee 5: customer URLs pass the SSRF guard", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2001:db8::1",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each(["8.8.8.8", "172.32.0.1", "13.235.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  test("a hostname that resolves to any private address is blocked", async () => {
    const resolve = async () => [
      { address: "13.235.1.1", family: 4 as const },
      { address: "10.0.0.5", family: 4 as const },
    ];
    await expect(
      checkedAddress(new URL("https://hooks.example.com/x"), { resolve }),
    ).rejects.toThrow(BlockedUrlError);
  });

  test("literal private IPs, plain http and credentials in the URL are blocked", async () => {
    await expect(checkedAddress(new URL("https://169.254.169.254/latest"), {})).rejects.toThrow(
      "non-public",
    );
    await expect(checkedAddress(new URL("https://[::1]/x"), {})).rejects.toThrow("non-public");
    await expect(checkedAddress(new URL("http://hooks.example.com/x"), {})).rejects.toThrow(
      "https",
    );
    await expect(
      checkedAddress(new URL("https://user:pw@hooks.example.com/x"), {}),
    ).rejects.toThrow("credentials");
  });

  describe("delivery is pinned to the checked address and never redirected", () => {
    let server: ReturnType<typeof Bun.serve>;
    const seen: { host: string | null; path: string }[] = [];
    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          seen.push({ host: request.headers.get("host"), path: new URL(request.url).pathname });
          return new URL(request.url).pathname === "/redirect"
            ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
            : new Response("ok");
        },
      });
    });
    afterAll(() => server.stop());

    const options = () => ({
      timeoutMs: 2_000,
      allowHttp: true,
      allowAddress: (address: string) => address === "127.0.0.1",
      // The name resolves only here: the request must go to this address, with the name kept.
      resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
    });

    test("connects to the address the guard checked, keeping the hostname", async () => {
      const result = await safePost(
        `http://hooks.example.invalid:${server.port}/hook`,
        "{}",
        {},
        options(),
      );
      expect(result.status).toBe(200);
      expect(seen.at(-1)).toEqual({ host: `hooks.example.invalid:${server.port}`, path: "/hook" });
    });

    test("a redirect is reported, not followed", async () => {
      const before = seen.length;
      expect(
        (
          await safePost(
            `http://hooks.example.invalid:${server.port}/redirect`,
            "{}",
            {},
            options(),
          )
        ).status,
      ).toBe(302);
      expect(seen.length).toBe(before + 1);
    });

    test("without the test allowance, loopback is refused before any connection", async () => {
      const before = seen.length;
      await expect(
        safePost(
          `http://127.0.0.1:${server.port}/hook`,
          "{}",
          {},
          { timeoutMs: 2_000, allowHttp: true },
        ),
      ).rejects.toThrow(BlockedUrlError);
      expect(seen.length).toBe(before);
    });
  });
});
