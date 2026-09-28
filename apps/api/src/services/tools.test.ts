/**
 * Saving a tool: what is refused, and what never leaves the database.
 *
 * The URL rules are the first SSRF layer only -- the worker checks the
 * address it actually connects to -- but they are the one a customer sees,
 * so they should refuse the obvious cases at the point of typing.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { decryptSecret, encryptSecret } from "./secrets";
import { prepareTool, ToolInputError, toolView, urlProblem } from "./tools";

beforeAll(() => {
  process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

const valid = {
  name: "lookup_order",
  description: "Look up an order by its id",
  url: "https://crm.example.com/orders",
  parametersSchema: { type: "object", properties: { orderId: { type: "string" } } },
};

async function errorsOf(input: object): Promise<Record<string, string>> {
  try {
    await prepareTool(input);
  } catch (error) {
    if (error instanceof ToolInputError) return error.fieldErrors;
    throw error;
  }
  return {};
}

describe("tool URLs", () => {
  test("a public https hostname is fine", () => {
    expect(urlProblem("https://crm.example.com/api/v1?x=1")).toBeNull();
    expect(urlProblem("https://crm.example.com:443/")).toBeNull();
  });

  test("refuses what could reach inside the network", () => {
    for (const url of [
      "http://crm.example.com/",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://2130706433/",
      "https://0x7f000001/",
      "https://[::1]/",
      "https://metadata.google.internal/",
      "https://printer.local/",
      "https://user:pass@crm.example.com/",
      "https://crm.example.com:8080/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect({ url, problem: urlProblem(url) !== null }).toEqual({ url, problem: true });
    }
  });
});

describe("preparing a tool", () => {
  test("a valid tool", async () => {
    const values = await prepareTool(valid);
    expect(values.name).toBe("lookup_order");
    expect(values.parametersSchema).toEqual(valid.parametersSchema);
  });

  test("a name the model can call, and not a built-in's", async () => {
    expect((await errorsOf({ ...valid, name: "look up" })).name).toBeTruthy();
    expect((await errorsOf({ ...valid, name: "end_call" })).name).toContain("reserved");
    expect((await errorsOf({ ...valid, name: "transfer_call" })).name).toContain("reserved");
  });

  test("a description is required, because it is how the model decides", async () => {
    expect((await errorsOf({ ...valid, description: "  " })).description).toBeTruthy();
  });

  test("the parameters must be an object schema that compiles", async () => {
    expect((await errorsOf({ ...valid, parametersSchema: { type: "string" } })).parametersSchema).toBeTruthy();
    expect((await errorsOf({ ...valid, parametersSchema: { type: "object", properties: 5 } })).parametersSchema).toBeTruthy();
  });

  test("credentials cannot be smuggled in plain headers", async () => {
    expect((await errorsOf({ ...valid, headers: { Authorization: "Bearer x" } })).headers).toBeTruthy();
    expect((await errorsOf({ ...valid, headers: { "X-Tenant": "kbs" } })).headers).toBeUndefined();
  });

  test("an authenticated tool needs a secret", async () => {
    expect((await errorsOf({ ...valid, authType: "bearer" })).authSecret).toBeTruthy();
  });

  test("the secret is stored encrypted, and decrypts to what was given", async () => {
    const values = await prepareTool({ ...valid, authType: "bearer", authSecret: "sk_live_123" });
    expect(values.authSecretCiphertext).not.toContain("sk_live_123");
    expect(await decryptSecret(values.authSecretCiphertext!)).toBe("sk_live_123");
  });

  test("an update keeps the stored secret unless a new one is given", async () => {
    const first = await prepareTool({ ...valid, authType: "bearer", authSecret: "one" });
    const existing = { ...first, id: "t", orgId: "o", headers: {}, method: "POST", enabled: true, isSlow: false, timeoutMs: 5000 } as never;
    const update = await prepareTool({ description: "Look up an order, faster" }, existing);
    expect(update.authSecretCiphertext).toBeUndefined();
    expect(update.description).toBe("Look up an order, faster");
  });

  test("timeouts are bounded", async () => {
    expect((await errorsOf({ ...valid, timeoutMs: 100 })).timeoutMs).toBeTruthy();
    expect((await errorsOf({ ...valid, timeoutMs: 120_000 })).timeoutMs).toBeTruthy();
  });
});

describe("secrets", () => {
  test("each encryption is different, so equal secrets are not visible as equal", async () => {
    const a = await encryptSecret("same");
    const b = await encryptSecret("same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(a)).toBe("same");
  });

  test("a tampered ciphertext does not decrypt", async () => {
    const sealed = await encryptSecret("value");
    const [version, iv, body] = sealed.split(":");
    const flipped = Buffer.from(body!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    await expect(decryptSecret([version, iv, flipped.toString("base64")].join(":"))).rejects.toThrow();
  });

  test("the dashboard view never includes the secret", async () => {
    const values = await prepareTool({ ...valid, authType: "bearer", authSecret: "sk_live_123" });
    const view = toolView({ ...values, id: "t", orgId: "o" } as never);
    expect(JSON.stringify(view)).not.toContain("authSecretCiphertext");
    expect(view.hasSecret).toBe(true);
  });
});
