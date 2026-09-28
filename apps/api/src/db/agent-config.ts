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
  /**
   * Run the model on Sarvam's realtime endpoint, finalising each utterance
   * when the worker's VAD hears the caller stop: about a quarter of a second
   * sooner per turn than the streaming endpoint.
   */
  sttRealtime: boolean;

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
   * Cost ceilings, in rupees.
   *
   * `budgetInr` bounds what one call may cost and ends it in stages when it
   * gets close; zero disables it. `maxInrPerMin` bounds the rate instead and
   * never ends a call: the agent is made terser as it nears the ceiling, and
   * speech it cannot afford is never synthesised. It cannot be disabled --
   * zero means the platform ceiling of Rs 2, and nothing above that is valid.
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

  /** Whether the agent may hang up once the conversation is over. */
  endCallEnabled: boolean;

  /**
   * The words a call ends on, by the hour in `timezone`: `start` inclusive,
   * `end` exclusive, a `start` after `end` running through midnight, and the
   * first match winning. The worker speaks the matching line itself as the
   * call ends; `{{caller_name}}` is the name the model heard. Empty leaves the
   * goodbye to the model.
   */
  closingLines: Array<{ start: number; end: number; text: string }>;

  /**
   * Where the agent may transfer a phone call. Field names inside each
   * target are single words, because only top-level keys are converted
   * between camelCase and the worker's snake_case.
   */
  transferTargets: Array<{ name: string; number: string; description?: string }>;

  /**
   * What to do when an outbound call the worker placed is answered by a
   * machine. An empty message with `leave_message` has the model compose one.
   */
  voicemailDetection: boolean;
  voicemailAction: "hangup" | "leave_message";
  voicemailMessage: string;

  /**
   * How the greeting is said. "instructions" has the model write it, a model
   * request per call; "verbatim" speaks it exactly, with its audio cached.
   * `recordingNotice` follows a verbatim greeting on a recorded call; empty
   * uses a default for the voice's language.
   */
  greetingMode: "instructions" | "verbatim";
  recordingNotice: string;

  /**
   * After the call: a summary, one of `dispositions`, and `analysisFields`
   * filled from the conversation, written by the language model and billed
   * with the call.
   */
  analysisEnabled: boolean;
  dispositions: string[];
  analysisFields: Array<{
    name: string;
    type?: "string" | "number" | "boolean" | "enum";
    description?: string;
    options?: string[];
  }>;
  /** What a good call looks like, each scored pass or fail after the call. */
  qaCriteria: string[];

  /** Seconds of mutual silence before checking in, and how many checks before hanging up. */
  silenceTimeout: number;
  silenceChecks: number;
  /** Keys the caller presses reach the agent as "[keypad: 1]". */
  dtmfInput: boolean;

  /** LiveKit Inference models to fail over to when Sarvam does not answer. */
  fallbackLlm: string | null;
  fallbackStt: string | null;
  fallbackTts: string | null;
  fallbackTtsVoice: string;
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
  sttRealtime: true,

  llmModel: "sarvam-105b-conversations",
  llmTemperature: null,
  maxResponseTokens: null,

  ttsModel: "bulbul:v3",
  ttsLanguage: "hi-IN",
  ttsSpeaker: "ritu",
  ttsPace: 1.0,

  budgetInr: 0,
  maxInrPerMin: 2,
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

  endCallEnabled: true,
  closingLines: [],
  transferTargets: [],
  voicemailDetection: true,
  voicemailAction: "hangup",
  voicemailMessage: "",

  greetingMode: "instructions",
  recordingNotice: "",

  analysisEnabled: true,
  dispositions: [
    "interested",
    "not_interested",
    "callback_requested",
    "resolved",
    "unresolved",
    "wrong_number",
    "do_not_call",
  ],
  analysisFields: [],
  qaCriteria: [],

  silenceTimeout: 15,
  silenceChecks: 2,
  dtmfInput: true,

  fallbackLlm: null,
  fallbackStt: null,
  fallbackTts: null,
  fallbackTtsVoice: "",
};
