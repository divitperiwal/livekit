/**
 * The shape of `agent_versions.config`.
 *
 * This mirrors the worker's own `AgentConfig`, minus the fields that live
 * elsewhere. `instructions`, `greeting` and `promptMode` are their own columns
 * -- the prompt and the rule for composing it are edited together, and a mode
 * pointing at a different prompt means nothing -- and `persona` is a
 * worker-side concept a database row replaces outright.
 *
 * The generated schema still carries `prompt_mode`, because the worker's model
 * accepts it either way. The control plane simply does not put it here.
 *
 * Worth being explicit about what this type is and is not. It describes the
 * shape; it does not validate the values. Whether `bulbul:v3` accepts the
 * speaker `anushka` is knowable only from the Sarvam plugin's own tables,
 * which live in the worker and cannot be imported here without dragging in the
 * entire voice stack. The next phase generates a JSON Schema from that Python
 * model and validates against it on write, so a bad combination is rejected in
 * the dashboard rather than at three in the morning on a live call.
 *
 * Until then, treat the defaults below as the only values known to be good.
 */

export interface AgentConfigJson {
  /** Speech to text. */
  sttModel: string;
  sttMode: string;
  sttLanguage: string;

  /** Language model. `llmTemperature: null` means the model's own default. */
  llmModel: string;
  llmTemperature: number | null;
  maxResponseTokens: number | null;

  /** Text to speech. The speaker roster is per model. */
  ttsModel: string;
  ttsLanguage: string;
  ttsSpeaker: string;
  ttsPace: number;

  /**
   * Cost ceilings, in rupees. Zero disables either one.
   *
   * `budgetInr` bounds what one call may cost and ends it in stages when it
   * gets close. `maxInrPerMin` bounds the rate instead, and never ends a call
   * -- it only makes the agent terser.
   */
  budgetInr: number;
  maxInrPerMin: number;
  budgetWarnAt: number;
  budgetWrapAt: number;
  budgetFarewell: string;

  /** Turn taking. */
  useTurnDetector: boolean;
  vadMinSilence: number;
  vadMinSpeech: number;
  vadActivationThreshold: number;
  vadPrefixPadding: number;
  endpointingMinDelay: number;
  endpointingMaxDelay: number;

  /**
   * The timezone the agent's clock runs in. A prompt that branches on the hour
   * -- "call back tomorrow morning" against "in ten minutes" -- needs this to
   * be the customer's local time, not the platform's.
   */
  timezone: string;
}

/**
 * Sensible defaults, matching the worker's own.
 *
 * Indic-first: Saaras with `codemix` keeps Hindi and English mixed as spoken
 * rather than forcing either into one script, which is how people actually
 * talk on these calls.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfigJson = {
  sttModel: "saaras:v4",
  sttMode: "codemix",
  sttLanguage: "hi-IN",

  llmModel: "sarvam-105b-conversations",
  llmTemperature: null,
  maxResponseTokens: null,

  ttsModel: "bulbul:v3",
  ttsLanguage: "hi-IN",
  ttsSpeaker: "ritu",
  ttsPace: 1.0,

  budgetInr: 0,
  maxInrPerMin: 0,
  budgetWarnAt: 0.7,
  budgetWrapAt: 0.9,
  budgetFarewell:
    "Thank the user warmly, tell them the call has to end now, and invite " +
    "them to call back if they need anything more.",

  useTurnDetector: true,
  vadMinSilence: 0.25,
  vadMinSpeech: 0.05,
  vadActivationThreshold: 0.5,
  vadPrefixPadding: 0.5,
  endpointingMinDelay: 0.3,
  endpointingMaxDelay: 2.5,

  timezone: "Asia/Kolkata",
};
