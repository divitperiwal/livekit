import { describe, expect, test } from "bun:test";
import { z } from "zod";
import workerContract from "../../../schema/internal-api.schema.json";
import { internalContract } from "../../src/contracts/internal";
import { schemaShape } from "./json-schema-shape";

const workerDefs = workerContract.$defs as unknown as Record<string, Record<string, unknown>>;

describe("the Zod contract matches the worker's exported contract", () => {
  test("both define the same shapes", () => {
    expect(Object.keys(internalContract).sort()).toEqual(Object.keys(workerDefs).sort());
  });

  for (const [name, zodSchema] of Object.entries(internalContract)) {
    test(name, () => {
      // Input form: what each side accepts, so defaulted fields are optional on both.
      const fromZod = z.toJSONSchema(zodSchema, { io: "input", target: "draft-2020-12" }) as Record<
        string,
        unknown
      >;
      expect(schemaShape(fromZod)).toEqual(schemaShape(workerDefs[name]!, workerDefs));
    });
  }
});
