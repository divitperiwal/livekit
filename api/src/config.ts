import { z } from "zod";

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
/** Encrypts secrets stored in the database. Generate with `openssl rand -base64 32`. */
const secretsKey = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "must be 32 bytes, base64-encoded",
  );

const OUTBOUND_VARIABLES = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "TELEPHONY_AGENT_NAME",
] as const;

const NUMBER_VARIABLES = [
  "PLIVO_AUTH_ID",
  "PLIVO_AUTH_TOKEN",
  "PLIVO_INBOUND_TRUNK_ID",
  "PUBLIC_BASE_URL",
] as const;

/** A group of variables that must be set together or not at all. */
function requireTogether(
  names: readonly string[],
  config: Record<string, unknown>,
  context: z.RefinementCtx,
) {
  const missing = names.filter((name) => !config[name]);
  if (missing.length === 0 || missing.length === names.length) return;
  const message = `required with the other variables of its group (${names.join(", ")})`;
  for (const name of missing) context.addIssue({ code: "custom", path: [name], message });
}

const configSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: databaseUrl,
    /** Shared with the worker; guards every /internal route. */
    INTERNAL_API_SECRET: z.string().min(32, "must be at least 32 characters"),
    SECRETS_KEY: secretsKey,
    /** Requests per API key per minute. */
    PUBLIC_API_RATE_PER_MIN: z.coerce.number().int().min(1).default(300),
    /** Outbound calls (`POST /v1/.../calls`) dispatch the worker through LiveKit. All four, or none. */
    LIVEKIT_URL: z.url().optional(),
    LIVEKIT_API_KEY: z.string().min(1).optional(),
    LIVEKIT_API_SECRET: z.string().min(1).optional(),
    /** The worker's agent name: the dispatch target. */
    TELEPHONY_AGENT_NAME: z.string().min(1).optional(),
    TELEPHONY_ROOM_PREFIX: z.string().min(1).default("call"),
    /** Renting numbers and KYC go through Plivo. All four, or none (number routes answer 503). */
    PLIVO_AUTH_ID: z.string().min(1).optional(),
    PLIVO_AUTH_TOKEN: z.string().min(1).optional(),
    /** The Zentrunk inbound trunk a rented number's calls are sent to. */
    PLIVO_INBOUND_TRUNK_ID: z.string().min(1).optional(),
    /** Where Plivo reaches this api from outside, e.g. https://voice.example.com. */
    PUBLIC_BASE_URL: z.url({ protocol: /^https$/ }).optional(),
  })
  .superRefine((config, context) => {
    requireTogether(OUTBOUND_VARIABLES, config, context);
    requireTogether(NUMBER_VARIABLES, config, context);
  });

/** The ops CLI touches only the database. */
const cliConfigSchema = z.object({ DATABASE_URL: databaseUrl, SECRETS_KEY: secretsKey });

/** The background process: webhook delivery, the stale-call sweep, recording retention and the number jobs. */
const backgroundConfigSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    SECRETS_KEY: secretsKey,
    /** The worker's own limit; a call running past it plus post-call time has lost its worker. */
    TELEPHONY_MAX_CALL_SECONDS: z.coerce.number().int().min(60),
    RECORDING_S3_BUCKET: z.string().min(1),
    RECORDING_S3_REGION: z.string().min(1),
    RECORDING_S3_ENDPOINT: z.url(),
    /** Needs delete access; the worker's key needs only write. */
    RECORDING_S3_ACCESS_KEY: z.string().min(1),
    RECORDING_S3_SECRET_KEY: z.string().min(1),
    /** Monthly rent, release retries and the KYC poll. Both, or neither (those jobs are off). */
    PLIVO_AUTH_ID: z.string().min(1).optional(),
    PLIVO_AUTH_TOKEN: z.string().min(1).optional(),
  })
  .superRefine((config, context) => {
    requireTogether(["PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN"], config, context);
  });

/** Only for commands that act on live rooms. */
const liveKitConfigSchema = z.object({
  LIVEKIT_URL: z.url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
});

/** Buying, linking and releasing numbers, and KYC. Loaded only where a step needs Plivo. */
const plivoConfigSchema = z.object({
  PLIVO_AUTH_ID: z.string().min(1),
  PLIVO_AUTH_TOKEN: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;
export type CliConfig = z.infer<typeof cliConfigSchema>;
export type LiveKitConfig = z.infer<typeof liveKitConfigSchema>;
export type PlivoConfig = z.infer<typeof plivoConfigSchema>;
export type BackgroundConfig = z.infer<typeof backgroundConfigSchema>;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

/** Validates every variable at once, so a bad deploy fails at startup with the whole list. */
function parseEnv<Schema extends z.ZodType>(schema: Schema, env: Env): z.output<Schema> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
  );
  throw new ConfigError(`invalid configuration:\n${problems.join("\n")}`);
}

export const loadConfig = (env: Env = process.env): Config => parseEnv(configSchema, env);
export const loadCliConfig = (env: Env = process.env): CliConfig => parseEnv(cliConfigSchema, env);
export const loadLiveKitConfig = (env: Env = process.env): LiveKitConfig =>
  parseEnv(liveKitConfigSchema, env);
export const loadPlivoConfig = (env: Env = process.env): PlivoConfig =>
  parseEnv(plivoConfigSchema, env);
export const loadBackgroundConfig = (env: Env = process.env): BackgroundConfig =>
  parseEnv(backgroundConfigSchema, env);
