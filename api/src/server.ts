import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { connectDatabase } from "./db/client";
import { liveKitCallDispatcher } from "./livekit";
import { BalanceChecker } from "./modules/billing/balance-check";
import { SecretBox } from "./modules/secrets/secret-box";

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

const database = connectDatabase(config.DATABASE_URL);
const app = createApp({
  db: database.db,
  config,
  balanceChecker: new BalanceChecker(),
  secretBox: new SecretBox(config.SECRETS_KEY),
  dispatcher,
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
