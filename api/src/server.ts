import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { connectDatabase } from "./db/client";
import { liveKitCallDispatcher } from "./livekit";
import { BalanceChecker } from "./modules/billing/balance-check";
import type { NumberServices } from "./modules/numbers/number-services";
import { plivoClient } from "./modules/numbers/plivo";
import { SecretBox } from "./modules/secrets/secret-box";
import { s3RecordingLinker } from "./storage";

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, TELEPHONY_AGENT_NAME } = config;
const dispatcher =
  LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET && TELEPHONY_AGENT_NAME
    ? liveKitCallDispatcher({
        LIVEKIT_URL,
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET,
        TELEPHONY_AGENT_NAME,
      })
    : null;
if (!dispatcher) {
  console.warn(
    "outbound calling is off: set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and TELEPHONY_AGENT_NAME",
  );
}

function numberServices(): NumberServices | null {
  const { PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_INBOUND_TRUNK_ID, PUBLIC_BASE_URL } = config;
  if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN || !PLIVO_INBOUND_TRUNK_ID || !PUBLIC_BASE_URL) {
    console.warn(
      "renting numbers and KYC are off: set PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_INBOUND_TRUNK_ID and PUBLIC_BASE_URL",
    );
    return null;
  }
  return {
    plivo: plivoClient({ authId: PLIVO_AUTH_ID, authToken: PLIVO_AUTH_TOKEN }),
    inboundTrunkId: PLIVO_INBOUND_TRUNK_ID,
    publicBaseUrl: PUBLIC_BASE_URL.replace(/\/$/, ""),
    callbackSecret: config.SECRETS_KEY,
  };
}

function recordingLinker() {
  const {
    RECORDING_S3_BUCKET,
    RECORDING_S3_REGION,
    RECORDING_S3_ENDPOINT,
    RECORDING_S3_ACCESS_KEY,
    RECORDING_S3_SECRET_KEY,
  } = config;
  if (
    !RECORDING_S3_BUCKET ||
    !RECORDING_S3_REGION ||
    !RECORDING_S3_ENDPOINT ||
    !RECORDING_S3_ACCESS_KEY ||
    !RECORDING_S3_SECRET_KEY
  ) {
    console.warn("recording links are off: set the five RECORDING_S3_* variables");
    return null;
  }
  return s3RecordingLinker({
    RECORDING_S3_BUCKET,
    RECORDING_S3_REGION,
    RECORDING_S3_ENDPOINT,
    RECORDING_S3_ACCESS_KEY,
    RECORDING_S3_SECRET_KEY,
  });
}

const database = connectDatabase(config.DATABASE_URL);
const app = createApp({
  db: database.db,
  config,
  balanceChecker: new BalanceChecker(),
  secretBox: new SecretBox(config.SECRETS_KEY),
  dispatcher,
  numbers: numberServices(),
  recordingLinker: recordingLinker(),
  roomPrefix: config.TELEPHONY_ROOM_PREFIX,
  ratePerMinute: config.PUBLIC_API_RATE_PER_MIN,
});
const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
console.log(`api listening on :${server.port}`);

process.on("SIGTERM", async () => {
  await server.stop();
  await database.close();
  process.exit(0);
});
