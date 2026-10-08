import Ajv2020 from "ajv/dist/2020";
import agentConfigSchema from "../../../../schema/agent-config.schema.json";

/**
 * The stored (camelCase) agent config, judged as the worker's `AgentConfigModel` judges
 * it (guarantee 17): ajv over the worker-generated schema, then the five rules JSON Schema
 * cannot express. `schema/agent-config.cases.json` holds cases both sides must agree on.
 */

/** Mirrors `ENDPOINTING_DELAYS_*` and `MIN_VAD_SILENCE_WITH_TURN_DETECTOR` in the worker's model. */
const ENDPOINTING_DELAYS_WITH_TURN_DETECTOR = [0.3, 2.5] as const;
const ENDPOINTING_DELAYS_WITHOUT_TURN_DETECTOR = [0.5, 3.0] as const;
const MIN_VAD_SILENCE_WITH_TURN_DETECTOR = 0.25;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateSchema = ajv.compile(agentConfigSchema);

const ttsSpeakers = agentConfigSchema["x-tts-speakers"] as Record<string, string[]>;
const timezones = new Set<string>(agentConfigSchema["x-timezones"]);
const properties = agentConfigSchema.properties as Record<string, { default?: unknown }>;

export type AgentConfig = Record<string, unknown>;
export type AgentConfigResult = { valid: true } | { valid: false; problems: string[] };

/** A field's value, or the model's default when it is not set. */
function effective<T>(config: AgentConfig, key: string): T {
  return (key in config ? config[key] : properties[key]?.default) as T;
}

function crossFieldProblems(config: AgentConfig): string[] {
  const problems: string[] = [];

  const ttsModel = effective<string>(config, "ttsModel");
  const speaker = effective<string>(config, "ttsSpeaker");
  if (!ttsSpeakers[ttsModel]?.includes(speaker)) {
    problems.push(`ttsSpeaker '${speaker}' is not a voice of ${ttsModel}`);
  }

  const timezone = effective<string>(config, "timezone");
  if (!timezones.has(timezone)) problems.push(`timezone '${timezone}' is not an IANA time zone`);

  if (
    effective<number>(config, "budgetInr") > 0 &&
    effective<number>(config, "budgetWrapAt") < effective<number>(config, "budgetWarnAt")
  ) {
    problems.push("budgetWrapAt must be at least budgetWarnAt when a budget is set");
  }

  const turnDetector = effective<boolean>(config, "useTurnDetector");
  if (
    turnDetector &&
    effective<number>(config, "vadMinSilence") < MIN_VAD_SILENCE_WITH_TURN_DETECTOR
  ) {
    problems.push(
      `vadMinSilence must be at least ${MIN_VAD_SILENCE_WITH_TURN_DETECTOR} with the turn detector on`,
    );
  }

  const [defaultMin, defaultMax] = turnDetector
    ? ENDPOINTING_DELAYS_WITH_TURN_DETECTOR
    : ENDPOINTING_DELAYS_WITHOUT_TURN_DETECTOR;
  const minDelay = effective<number | null>(config, "endpointingMinDelay") ?? defaultMin;
  const maxDelay = effective<number | null>(config, "endpointingMaxDelay") ?? defaultMax;
  if (minDelay > maxDelay) problems.push("endpointingMinDelay must not exceed endpointingMaxDelay");

  return problems;
}

export function validateAgentConfig(config: unknown): AgentConfigResult {
  if (!validateSchema(config)) {
    const problems = (validateSchema.errors ?? []).map((error) => {
      const where = error.instancePath
        ? error.instancePath.slice(1).replaceAll("/", ".")
        : "config";
      const extra =
        error.keyword === "additionalProperties"
          ? ` '${(error.params as { additionalProperty: string }).additionalProperty}'`
          : "";
      return `${where}: ${error.message}${extra}`;
    });
    return { valid: false, problems };
  }
  const problems = crossFieldProblems(config as AgentConfig);
  return problems.length === 0 ? { valid: true } : { valid: false, problems };
}
