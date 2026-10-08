import { describe, expect, test } from "bun:test";
import cases from "../../../schema/agent-config.cases.json";
import { validateAgentConfig } from "../../src/modules/agents/agent-config";

/** API half: the worker's pydantic model runs the same cases in its own test. */
describe("guarantee 17: the API judges every shared agent config case as the worker does", () => {
  for (const { name, config } of cases.valid) {
    test(`valid: ${name}`, () => {
      expect(validateAgentConfig(config)).toEqual({ valid: true });
    });
  }
  for (const { name, config } of cases.invalid) {
    test(`invalid: ${name}`, () => {
      expect(validateAgentConfig(config).valid).toBe(false);
    });
  }
});
