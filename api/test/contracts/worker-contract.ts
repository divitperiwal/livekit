import Ajv2020 from "ajv/dist/2020";
import workerContract from "../../../schema/internal-api.schema.json";

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(workerContract, "internal");

type DefName = keyof typeof workerContract.$defs;

/** Fails the test unless `body` is valid for the worker's own exported schema. */
export function assertWorkerAccepts(defName: DefName, body: unknown): void {
  const validate = ajv.getSchema(`internal#/$defs/${defName}`);
  if (!validate) throw new Error(`no ${defName} in the worker contract`);
  if (!validate(body)) {
    throw new Error(
      `the worker would reject this ${defName}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body, null, 2)}`,
    );
  }
}
