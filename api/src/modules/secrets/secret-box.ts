import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM for secrets stored in the database (`*_ciphertext` columns). */
export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, "base64");
    if (this.#key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
  }

  decrypt(stored: string): string {
    const [version, payload] = stored.split(":");
    if (version !== VERSION || !payload) throw new Error("unrecognised secret format");
    const bytes = Buffer.from(payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, IV_BYTES));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}
