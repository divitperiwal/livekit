/**
 * The control plane's half of the configuration contract.
 *
 * `agreement.test.ts` checks that these verdicts match the worker's. These
 * tests check the behaviour a customer sees: which configurations are
 * accepted, and whether a rejection says something useful.
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_CONFIG } from "./agent-config";
import {
  AgentConfigError,
  speakersFor,
  ttsModels,
  validateAgentConfig,
} from "./validate-config";

describe("validateAgentConfig", () => {
  test("accepts the defaults", () => {
    expect(() => validateAgentConfig(DEFAULT_AGENT_CONFIG)).not.toThrow();
  });

  test("accepts an empty object, since every field has a default", () => {
    expect(() => validateAgentConfig({})).not.toThrow();
  });

  test("rejects an unknown model and lists the real ones", () => {
    try {
      validateAgentConfig({ sttModel: "saaras:v9" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConfigError);
      const message = (error as AgentConfigError).fieldErrors.sttModel!;
      expect(message).toContain("saaras:v4");
    }
  });

  test("rejects a misspelled field rather than silently storing it", () => {
    // Without this the dashboard would accept the typo, store it, and the
    // worker would reject the whole configuration at call time.
    try {
      validateAgentConfig({ sttModle: "saaras:v4" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as AgentConfigError).fieldErrors.sttModle).toContain(
        "not a recognised setting",
      );
    }
  });

  test("rejects a voice from the wrong model generation", () => {
    // The rule JSON Schema cannot express: bulbul:v3 replaced the v2 roster
    // wholesale, so a v2 name is invalid on v3.
    try {
      validateAgentConfig({ ttsModel: "bulbul:v3", ttsSpeaker: "anushka" });
      throw new Error("expected a rejection");
    } catch (error) {
      const message = (error as AgentConfigError).fieldErrors.ttsSpeaker!;
      expect(message).toContain("not a voice on bulbul:v3");
      expect(message).toContain("ritu");
    }
  });

  test("accepts that same voice on the model it belongs to", () => {
    expect(() =>
      validateAgentConfig({ ttsModel: "bulbul:v2", ttsSpeaker: "anushka" }),
    ).not.toThrow();
  });

  test("reports every problem at once", () => {
    // A customer fixing a form should see everything wrong with it, not one
    // error per save.
    try {
      validateAgentConfig({ sttModel: "nope", llmModel: "also-nope" });
      throw new Error("expected a rejection");
    } catch (error) {
      const fields = Object.keys((error as AgentConfigError).fieldErrors);
      expect(fields).toContain("sttModel");
      expect(fields).toContain("llmModel");
    }
  });

  test("rejects a non-object", () => {
    expect(() => validateAgentConfig(null)).toThrow(AgentConfigError);
    expect(() => validateAgentConfig([])).toThrow(AgentConfigError);
    expect(() => validateAgentConfig("config")).toThrow(AgentConfigError);
  });

  test("enforces numeric bounds", () => {
    expect(() => validateAgentConfig({ ttsPace: 0 })).toThrow(AgentConfigError);
    expect(() => validateAgentConfig({ maxResponseTokens: 0 })).toThrow(
      AgentConfigError,
    );
    expect(() => validateAgentConfig({ llmTemperature: 5 })).toThrow(
      AgentConfigError,
    );
  });

  test("allows null where the worker treats it as 'use the default'", () => {
    expect(() =>
      validateAgentConfig({ llmTemperature: null, maxResponseTokens: null }),
    ).not.toThrow();
  });
});

describe("dropdown helpers", () => {
  test("speakersFor returns the roster of a model", () => {
    expect(speakersFor("bulbul:v3")).toContain("ritu");
    expect(speakersFor("bulbul:v3")).not.toContain("anushka");
    expect(speakersFor("bulbul:v2")).toContain("anushka");
  });

  test("speakersFor is empty for an unknown model", () => {
    expect(speakersFor("bulbul:v9")).toEqual([]);
  });

  test("ttsModels lists what the installed plugin supports", () => {
    expect(ttsModels()).toContain("bulbul:v3");
  });
});
