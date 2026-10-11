import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Plivo } from "./plivo";

/** Everything renting and KYC need. Null in the app when Plivo is not configured. */
export type NumberServices = {
  plivo: Plivo;
  /** The Zentrunk inbound trunk every rented number answers on. */
  inboundTrunkId: string;
  /** Where Plivo reaches this api, without a trailing slash. */
  publicBaseUrl: string;
  /** Signs each org's KYC callback URL. */
  callbackSecret: string;
};

/**
 * Plivo's KYC callback body is undocumented, so it is only a nudge to re-read the status
 * from Plivo. The URL carries an HMAC of the org id, so nobody else can trigger it.
 */
export function kycCallbackUrl(services: NumberServices, orgId: string): string {
  const token = kycCallbackToken(services.callbackSecret, orgId);
  return `${services.publicBaseUrl}/plivo/kyc/${orgId}?token=${token}`;
}

export function isKycCallbackToken(secret: string, orgId: string, token: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(token), digest(kycCallbackToken(secret, orgId)));
}

function kycCallbackToken(secret: string, orgId: string): string {
  return createHmac("sha256", secret).update(`plivo-kyc-callback:${orgId}`).digest("base64url");
}
