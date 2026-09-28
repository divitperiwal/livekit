/**
 * Encrypting stored secrets at rest: tool credentials, webhook signing secrets.
 *
 * A tool's bearer token or API key opens the customer's own CRM. Stored in the
 * clear, every database dump, read replica and support query would carry
 * them. So they are sealed with AES-256-GCM under a key that lives in the
 * environment rather than the database: a dump without the key is useless,
 * and the key can be rotated without touching application code.
 *
 * The format is `v1:<iv>:<ciphertext>`, base64 parts. The version prefix is
 * what makes a future key rotation or algorithm change a migration rather than
 * a guess about what each stored value is.
 */

import { env } from "../env";

const VERSION = "v1";
const IV_BYTES = 12;

export class SecretsUnavailable extends Error {
  constructor() {
    super(
      "SECRETS_KEY is not set, so secrets cannot be stored or read. " +
        "Generate one with `openssl rand -base64 32`.",
    );
    this.name = "SecretsUnavailable";
  }
}

let cached: { raw: string; key: CryptoKey } | undefined;

async function key(): Promise<CryptoKey> {
  const raw = env.secretsKey;
  if (!raw) throw new SecretsUnavailable();
  if (cached?.raw === raw) return cached.key;

  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  }
  const imported = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  cached = { raw, key: imported };
  return imported;
}

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    new TextEncoder().encode(plain),
  );
  return [
    VERSION,
    Buffer.from(iv).toString("base64"),
    Buffer.from(sealed).toString("base64"),
  ].join(":");
}

export async function decryptSecret(stored: string): Promise<string> {
  const [version, iv, sealed] = stored.split(":");
  if (version !== VERSION || !iv || !sealed) {
    throw new Error("unrecognised secret format");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
    await key(),
    Buffer.from(sealed, "base64"),
  );
  return new TextDecoder().decode(plain);
}
