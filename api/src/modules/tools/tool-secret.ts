import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../../db/database";
import { accounts } from "../../db/schema";
import type { SecretBox } from "../secrets/secret-box";

/**
 * One secret per account signs every customer tool request of its agents (decided 15 Oct
 * 2026: automitra has one, marcofed has one). Shown once when set; setting it again
 * replaces it at once.
 */
export function generateToolSecret(): string {
  return `tsec_${randomBytes(32).toString("base64url")}`;
}

/** The new secret, for the ops CLI to show once. */
export async function rotateToolSecret(
  db: Database,
  secretBox: SecretBox,
  accountId: string,
): Promise<string> {
  const secret = generateToolSecret();
  await db
    .update(accounts)
    .set({ toolSecretCiphertext: secretBox.encrypt(secret), updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  return secret;
}

export async function accountHasToolSecret(db: Database, accountId: string): Promise<boolean> {
  const [account] = await db
    .select({ toolSecretCiphertext: accounts.toolSecretCiphertext })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return Boolean(account?.toolSecretCiphertext);
}

/** A version with customer tools cannot run them unsigned, so it is refused before it is saved. */
export async function missingToolSecretProblem(
  db: Database,
  accountId: string,
  config: Record<string, unknown>,
): Promise<string | null> {
  const hasTools = Array.isArray(config.httpTools) && config.httpTools.length > 0;
  if (!hasTools || (await accountHasToolSecret(db, accountId))) return null;
  return "httpTools need the account's tool signing secret: ask us to set one";
}

/**
 * `X-Automitra-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<METHOD>.<path?query>.<body>">`.
 * The method and query are signed too: a GET carries its arguments there, not in a body.
 */
export function toolSignatureHeader(
  secret: string,
  signed: { timestamp: string; method: string; pathAndQuery: string; body: string },
): string {
  const text = `${signed.timestamp}.${signed.method}.${signed.pathAndQuery}.${signed.body}`;
  return `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;
}
