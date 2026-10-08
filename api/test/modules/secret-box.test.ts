import { expect, test } from "bun:test";
import { SecretBox } from "../../src/modules/secrets/secret-box";

const box = new SecretBox(Buffer.alloc(32, 1).toString("base64"));

test("a secret round-trips and never appears in its ciphertext", () => {
  const stored = box.encrypt("bearer-token-123");
  expect(stored).not.toContain("bearer-token-123");
  expect(box.decrypt(stored)).toBe("bearer-token-123");
});

test("the same secret encrypts differently each time", () => {
  expect(box.encrypt("x")).not.toBe(box.encrypt("x"));
});

test("a tampered or foreign ciphertext is rejected", () => {
  const stored = box.encrypt("x");
  const tampered = stored.slice(0, -2) + (stored.endsWith("A") ? "BB" : "AA");
  expect(() => box.decrypt(tampered)).toThrow();
  expect(() => new SecretBox(Buffer.alloc(32, 2).toString("base64")).decrypt(stored)).toThrow();
});
