/** The background process: same image as the api, run as `bun src/background.ts`. */
import { ConfigError, loadBackgroundConfig } from "./config";
import { connectDatabase } from "./db/client";
import { backgroundJobs } from "./jobs/jobs";
import { startJobs } from "./jobs/runner";
import { plivoClient } from "./modules/numbers/plivo";
import { SecretBox } from "./modules/secrets/secret-box";
import { s3RecordingDeleter } from "./storage";

let config;
try {
  config = loadBackgroundConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const { PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN } = config;
const plivo =
  PLIVO_AUTH_ID && PLIVO_AUTH_TOKEN
    ? plivoClient({ authId: PLIVO_AUTH_ID, authToken: PLIVO_AUTH_TOKEN })
    : null;
if (!plivo) console.warn("number jobs are off: set PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN");

const database = connectDatabase(config.DATABASE_URL);
const jobs = startJobs(
  backgroundJobs({
    db: database.db,
    secretBox: new SecretBox(config.SECRETS_KEY),
    deleteRecording: s3RecordingDeleter(config),
    maxCallSeconds: config.TELEPHONY_MAX_CALL_SECONDS,
    plivo,
  }),
);
console.log("background jobs running");

process.on("SIGTERM", async () => {
  await jobs.stop();
  await database.close();
  process.exit(0);
});
