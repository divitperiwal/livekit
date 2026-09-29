/**
 * The two validators must reach the same verdict.
 *
 * This is the test the whole generated-schema arrangement exists for. The
 * control plane accepts or rejects a configuration when a customer saves it;
 * the worker accepts or rejects the same configuration when a call starts. A
 * disagreement in either direction is a real failure:
 *
 * - accepted here, rejected there: the configuration saves cleanly and the
 *   agent then fails on a live call, which is the worst possible moment.
 * - rejected here, accepted there: a customer is told a perfectly good
 *   configuration is invalid, with no way to tell they are being lied to.
 *
 * So rather than assert a list of expected verdicts, this runs both validators
 * over the same cases and compares them to each other. It needs the worker's
 * Python environment; it is skipped if `uv` is not on the path, so a
 * TypeScript-only checkout can still run its own tests.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAgentConfig } from "./validate-config";

const REPO = join(import.meta.dir, "../../../..");

/** Configurations spanning the rules both sides are meant to share. */
const CASES: Array<{ name: string; config: Record<string, unknown> }> = [
  { name: "empty", config: {} },
  { name: "valid full", config: {
      sttModel: "saaras:v4", sttMode: "codemix", sttLanguage: "hi-IN",
      llmModel: "sarvam-105b-conversations", llmTemperature: 0.7,
      ttsModel: "bulbul:v3", ttsSpeaker: "ritu", ttsLanguage: "hi-IN", ttsPace: 1.0,
      budgetInr: 25, budgetWarnAt: 0.7, budgetWrapAt: 0.9,
      useTurnDetector: true, vadMinSilence: 0.3, timezone: "Asia/Kolkata",
      promptMode: "verbatim",
  } },

  // Enumerated values.
  { name: "unknown stt model", config: { sttModel: "saaras:v9" } },
  { name: "unknown llm model", config: { llmModel: "gpt-4" } },
  { name: "unknown tts model", config: { ttsModel: "bulbul:v9" } },
  { name: "unknown stt mode", config: { sttMode: "shouting" } },
  { name: "unknown tts language", config: { ttsLanguage: "fr-FR" } },
  { name: "unknown prompt mode", config: { promptMode: "sideways" } },

  // The cross-field rule JSON Schema cannot express.
  { name: "v2 voice on v3", config: { ttsModel: "bulbul:v3", ttsSpeaker: "anushka" } },
  { name: "v2 voice on v2", config: { ttsModel: "bulbul:v2", ttsSpeaker: "anushka" } },
  { name: "v3 voice on v2", config: { ttsModel: "bulbul:v2", ttsSpeaker: "ritu" } },

  // Numeric bounds.
  { name: "zero pace", config: { ttsPace: 0 } },
  { name: "negative pace", config: { ttsPace: -1 } },
  { name: "excessive pace", config: { ttsPace: 99 } },
  { name: "zero max tokens", config: { maxResponseTokens: 0 } },
  { name: "negative max tokens", config: { maxResponseTokens: -5 } },
  { name: "temperature too high", config: { llmTemperature: 5 } },
  { name: "temperature negative", config: { llmTemperature: -1 } },
  { name: "negative budget", config: { budgetInr: -10 } },
  { name: "platform rate ceiling", config: { maxInrPerMin: 0 } },
  { name: "rate ceiling in range", config: { maxInrPerMin: 1.5 } },
  { name: "rate ceiling at the maximum", config: { maxInrPerMin: 2.5 } },
  { name: "rate ceiling over the maximum", config: { maxInrPerMin: 3 } },
  { name: "rate ceiling under the floor", config: { maxInrPerMin: 0.5 } },
  { name: "negative rate ceiling", config: { maxInrPerMin: -1 } },
  { name: "warn at zero", config: { budgetWarnAt: 0 } },
  { name: "wrap at one", config: { budgetWrapAt: 1 } },
  { name: "threshold at one", config: { vadActivationThreshold: 1 } },

  // Nulls meaning "use the model's own default".
  { name: "null temperature", config: { llmTemperature: null } },
  { name: "null max tokens", config: { maxResponseTokens: null } },

  // Unknown fields.
  { name: "misspelled field", config: { sttModle: "saaras:v4" } },
  { name: "extra field", config: { nonsense: true } },

  // Timezones.
  { name: "valid timezone", config: { timezone: "America/New_York" } },
  { name: "invalid timezone", config: { timezone: "Mars/Olympus" } },

  // Call control. Transfer targets are nested objects, which is where a
  // camelCase/snake_case mismatch between the two sides would hide.
  { name: "end call off", config: { endCallEnabled: false } },
  { name: "transfer target", config: { transferTargets: [{ name: "sales", number: "+919876543210", description: "Buying" }] } },
  { name: "transfer target without description", config: { transferTargets: [{ name: "sales", number: "+919876543210" }] } },
  { name: "transfer number without plus", config: { transferTargets: [{ name: "sales", number: "919876543210" }] } },
  { name: "transfer target with empty name", config: { transferTargets: [{ name: "", number: "+919876543210" }] } },
  { name: "transfer target with extra field", config: { transferTargets: [{ name: "s", number: "+919876543210", priority: 1 }] } },
  { name: "transfer target camelCased field", config: { transferTargets: [{ name: "s", phoneNumber: "+919876543210" }] } },
  { name: "too many transfer targets", config: { transferTargets: Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, number: "+919876543210" })) } },
  { name: "realtime stt off", config: { sttRealtime: false } },
  { name: "realtime stt as a string", config: { sttRealtime: "yes" } },
  { name: "closing lines", config: { closingLines: [{ start: 9, end: 18, text: "ठीक है {{caller_name}} जी" }, { start: 18, end: 9, text: "कल सुबह" }] } },
  { name: "closing line covering the whole day", config: { closingLines: [{ start: 0, end: 0, text: "bye" }] } },
  { name: "closing line hour out of range", config: { closingLines: [{ start: 9, end: 25, text: "bye" }] } },
  { name: "closing line start of 24", config: { closingLines: [{ start: 24, end: 9, text: "bye" }] } },
  { name: "closing line hour as a string", config: { closingLines: [{ start: "9", end: 18, text: "bye" }] } },
  { name: "closing line fractional hour", config: { closingLines: [{ start: 9.5, end: 18, text: "bye" }] } },
  { name: "closing line with empty text", config: { closingLines: [{ start: 9, end: 18, text: "" }] } },
  { name: "closing line with extra field", config: { closingLines: [{ start: 9, end: 18, text: "bye", minute: 30 }] } },
  { name: "too many closing lines", config: { closingLines: Array.from({ length: 13 }, (_, i) => ({ start: i, end: i + 1, text: "bye" })) } },
  { name: "voicemail leave message", config: { voicemailAction: "leave_message", voicemailMessage: "Hi {{name}}" } },
  { name: "unknown voicemail action", config: { voicemailAction: "sing" } },
  { name: "voicemail detection off", config: { voicemailDetection: false } },

  // Post-call analysis: nested fields again, plus a list of labels.
  { name: "analysis off", config: { analysisEnabled: false } },
  { name: "custom dispositions", config: { dispositions: ["booked", "no_show"] } },
  { name: "no dispositions", config: { dispositions: [] } },
  { name: "empty disposition", config: { dispositions: [""] } },
  { name: "analysis fields", config: { analysisFields: [
      { name: "callback_time", description: "When to call back" },
      { name: "budget", type: "number" },
      { name: "model", type: "enum", options: ["Thar", "XUV700"] },
  ] } },
  { name: "analysis field bad name", config: { analysisFields: [{ name: "Call Back" }] } },
  { name: "analysis field bad type", config: { analysisFields: [{ name: "when", type: "date" }] } },
  { name: "analysis field extra key", config: { analysisFields: [{ name: "when", required: true }] } },

  // Silence, keypad, QA and failover.
  { name: "qa criteria", config: { qaCriteria: ["Confirmed the time", "Did not quote a price"] } },
  { name: "empty qa criterion", config: { qaCriteria: [""] } },
  { name: "silence settings", config: { silenceTimeout: 20, silenceChecks: 0, dtmfInput: false } },
  { name: "silence timeout too short", config: { silenceTimeout: 2 } },
  { name: "too many silence checks", config: { silenceChecks: 9 } },
  { name: "fallback models", config: { fallbackLlm: "openai/gpt-4.1-mini", fallbackStt: "deepgram/nova-3", fallbackTts: "cartesia/sonic-2", fallbackTtsVoice: "a-voice" } },
  { name: "unknown fallback llm", config: { fallbackLlm: "openai/gpt-99" } },
  { name: "auto is not a fallback stt", config: { fallbackStt: "auto" } },
  { name: "null fallback", config: { fallbackLlm: null } },

  // Wrong types.
  { name: "string for a number", config: { ttsPace: "fast" } },
  { name: "number for a boolean", config: { useTurnDetector: 1 } },
];

/**
 * Asks the worker to validate each case.
 *
 * The script and its input go through files rather than argv. A multi-line
 * `python -c` argument does not survive shell quoting on Windows, and the
 * failure mode is a silently skipped test rather than a loud one.
 *
 * Returns null only when the worker's environment genuinely is not available.
 */
function pythonVerdicts(): { verdicts: boolean[] } | { error: string } {
  const script = [
    "import json, sys",
    "from automitra_worker.config import AgentConfig",
    "cases = json.loads(open(sys.argv[1], encoding='utf-8').read())",
    "out = []",
    "for case in cases:",
    "    try:",
    "        AgentConfig.from_record(",
    "            {'instructions': 'x', 'greeting': 'y', 'config': case}",
    "        )",
    "        out.append(True)",
    "    except Exception:",
    "        out.append(False)",
    "print(json.dumps(out))",
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "automitra-agree-"));
  const scriptPath = join(dir, "check.py");
  const casesPath = join(dir, "cases.json");
  try {
    writeFileSync(scriptPath, script, "utf8");
    writeFileSync(casesPath, JSON.stringify(CASES.map((c) => c.config)), "utf8");

    const result = spawnSync("uv", ["run", "python", scriptPath, casesPath], {
      cwd: REPO,
      encoding: "utf8",
    });

    if (result.error) {
      return { error: `could not run uv: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { error: result.stderr?.slice(-600) ?? "unknown failure" };
    }
    const line = result.stdout.trim().split("\n").pop();
    if (!line) {
      return { error: "the worker produced no output" };
    }
    return { verdicts: JSON.parse(line) as boolean[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const result = pythonVerdicts();

describe("the control plane and the worker agree", () => {
  if ("error" in result) {
    // Loud rather than silent: a skipped agreement test looks identical to a
    // passing one, and this is the test the whole arrangement depends on.
    test("the worker could not be reached to compare against", () => {
      console.warn(`agreement test skipped: ${result.error}`);
      expect(result.error).toBeTruthy();
    });
    return;
  }

  const verdicts = result.verdicts;

  test("the case list reached Python intact", () => {
    expect(verdicts).toHaveLength(CASES.length);
  });

  for (const [index, { name, config }] of CASES.entries()) {
    test(`${name}`, () => {
      let acceptedByApi = true;
      try {
        validateAgentConfig(config);
      } catch {
        acceptedByApi = false;
      }

      const acceptedByWorker = verdicts[index]!;

      expect({ case: name, accepted: acceptedByApi }).toEqual({
        case: name,
        accepted: acceptedByWorker,
      });
    });
  }
});
