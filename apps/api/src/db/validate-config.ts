/**
 * Validates an agent configuration before it is stored.
 *
 * The rules are not written here. They come from
 * `packages/shared/agent-config.schema.json`, which is generated from the
 * worker's pydantic model, whose enumerated values come in turn from the
 * Sarvam plugin's own tables. A voice that model does not accept is rejected
 * here for the same reason and with the same list of alternatives.
 *
 * Writing the rules again in TypeScript would produce two definitions that
 * agree the day they are written and diverge afterwards. The visible symptom
 * is the one this arrangement exists to prevent: a configuration that saves
 * cleanly in the dashboard and then fails at three in the morning on a live
 * call.
 *
 * Regenerate the schema with:
 *   uv run python worker/scripts/export_schema.py
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// The 2020-12 entry point specifically: the default export handles draft-07
// and rejects the `$schema` the generator writes.
import { Ajv2020 as Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

import type { AgentConfigJson } from "./agent-config";

const SCHEMA_PATH = join(
  import.meta.dir,
  "../../../../packages/shared/agent-config.schema.json",
);

/**
 * The schema keys are storage names in snake_case; the API speaks camelCase.
 * Converting here keeps that difference at the boundary rather than spread
 * through the codebase.
 */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

interface GeneratedSchema {
  "x-tts-speakers": Record<string, string[]>;
  "x-timezones": string[];
  [key: string]: unknown;
}

let validator: ValidateFunction | undefined;
let schema: GeneratedSchema | undefined;

function load(): { validate: ValidateFunction; schema: GeneratedSchema } {
  if (!validator || !schema) {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as GeneratedSchema;
    // `allErrors` so a customer fixing a form sees everything wrong with it at
    // once, rather than one problem per save.
    const ajv = new Ajv({ allErrors: true, strict: false });
    validator = ajv.compile(schema);
  }
  return { validate: validator, schema };
}

/** The voices available on a TTS model, for populating a dropdown. */
export function speakersFor(ttsModel: string): string[] {
  return load().schema["x-tts-speakers"][ttsModel] ?? [];
}

/** Every TTS model the installed plugin supports. */
export function ttsModels(): string[] {
  return Object.keys(load().schema["x-tts-speakers"]);
}

export class AgentConfigError extends Error {
  constructor(
    message: string,
    /** Per-field messages, keyed camelCase for the dashboard form. */
    readonly fieldErrors: Record<string, string>,
  ) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/** Turns an ajv error into something a person can act on. */
function describe(error: ErrorObject): { field: string; message: string } {
  const path = error.instancePath.replace(/^\//, "");

  if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty: string })
      .additionalProperty;
    return {
      field: toCamel(extra),
      message: `${toCamel(extra)} is not a recognised setting`,
    };
  }

  if (error.keyword === "enum") {
    const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
    return {
      field: toCamel(path),
      message: `must be one of: ${allowed.join(", ")}`,
    };
  }

  return { field: toCamel(path) || "config", message: error.message ?? "is invalid" };
}

/**
 * Validates a configuration, returning it unchanged or throwing.
 *
 * What this does not check: whether the chosen voice suits the chosen
 * language, whether a prompt is any good, or anything else that needs
 * judgement rather than a rule.
 *
 * The speaker rule is applied separately. Whether a voice exists on the chosen
 * TTS model is a relationship between two fields rather than a constraint on
 * either, so JSON Schema cannot express it and the worker enforces it in a
 * model validator that generates nothing. Without the check below, a v2 voice
 * on a v3 model would save cleanly here and fail once a call was connected.
 */
export function validateAgentConfig(config: unknown): AgentConfigJson {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new AgentConfigError("config must be an object", {
      config: "must be an object",
    });
  }

  const snake: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    snake[toSnake(key)] = value;
  }

  const { validate, schema } = load();
  const fieldErrors: Record<string, string> = {};

  if (!validate(snake)) {
    for (const error of validate.errors ?? []) {
      const { field, message } = describe(error);
      fieldErrors[field] ??= message;
    }
  }

  // Only worth checking once both fields are individually valid; otherwise the
  // message would compound an error already being reported.
  if (!fieldErrors.ttsModel && !fieldErrors.ttsSpeaker) {
    const model = (snake.tts_model as string) ?? "bulbul:v3";
    const speaker = (snake.tts_speaker as string) ?? "ritu";
    const allowed = schema["x-tts-speakers"][model];
    if (allowed && !allowed.includes(speaker)) {
      fieldErrors.ttsSpeaker =
        `is not a voice on ${model}. Choose one of: ${allowed.join(", ")}`;
    }
  }

  // The other rule the schema cannot carry: the worker validates a timezone by
  // constructing a ZoneInfo, which generates nothing. Without this, a typo
  // saves here and fails on the call.
  if (!fieldErrors.timezone && snake.timezone !== undefined) {
    if (!schema["x-timezones"].includes(snake.timezone as string)) {
      fieldErrors.timezone =
        `is not a known IANA timezone, such as Asia/Kolkata or America/New_York`;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    const summary = Object.entries(fieldErrors)
      .map(([field, message]) => `${field} ${message}`)
      .join("; ");
    throw new AgentConfigError(summary, fieldErrors);
  }

  return config as AgentConfigJson;
}
