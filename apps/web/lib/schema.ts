/**
 * The agent-configuration options a form may offer.
 *
 * Read from the same generated schema the API validates against, rather than
 * hardcoded here. A dropdown built from a copied list eventually offers a
 * value the worker rejects -- and the dropdown is exactly where someone would
 * reasonably assume every option is valid.
 *
 * Server-only: this reads from disk.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PropertySchema {
  enum?: string[];
  default?: unknown;
  /** A nullable choice is `anyOf: [{ enum }, { type: "null" }]`. */
  anyOf?: Array<{ enum?: string[] }>;
}

interface GeneratedSchema {
  properties: Record<string, PropertySchema>;
  "x-tts-speakers": Record<string, string[]>;
  "x-timezones": string[];
}

const SCHEMA_PATH = join(
  process.cwd(),
  "../../packages/shared/agent-config.schema.json",
);

let cached: GeneratedSchema | undefined;

function schema(): GeneratedSchema {
  if (!cached) {
    cached = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as GeneratedSchema;
  }
  return cached;
}

/** The allowed values for a field, in storage (snake_case) naming. */
export function options(field: string): string[] {
  const property = schema().properties[field];
  return property?.enum ?? property?.anyOf?.find((branch) => branch.enum)?.enum ?? [];
}

export function defaultFor(field: string): string {
  const value = schema().properties[field]?.default;
  return typeof value === "string" ? value : "";
}

/** Voices are per model: the v2 roster was replaced wholesale in v3. */
export function speakersFor(ttsModel: string): string[] {
  return schema()["x-tts-speakers"][ttsModel] ?? [];
}

export function ttsModels(): string[] {
  return Object.keys(schema()["x-tts-speakers"]);
}

/** A short list of plausible zones rather than all six hundred. */
export function commonTimezones(): string[] {
  const all = new Set(schema()["x-timezones"]);
  return [
    "Asia/Kolkata",
    "Asia/Dubai",
    "Asia/Singapore",
    "Europe/London",
    "America/New_York",
    "America/Los_Angeles",
  ].filter((zone) => all.has(zone));
}
