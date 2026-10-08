import { SecretBox } from "../../src/modules/secrets/secret-box";

export const TEST_SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
export const testSecretBox = new SecretBox(TEST_SECRETS_KEY);
