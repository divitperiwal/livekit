import { z } from "zod";

/**
 * A version's `httpTools`, typed. Mirrors `HttpTool` and `ToolParameter` in the worker's
 * model, defaults included; stored configs were already judged by `validateAgentConfig`.
 */
const toolParameterSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "enum"]).default("string"),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(true),
});

export const httpToolSchema = z.object({
  name: z.string(),
  method: z.enum(["GET", "POST"]).default("GET"),
  url: z.string(),
  parameters: z.array(toolParameterSchema).default([]),
  timeout: z.number().default(5),
});

export type HttpTool = z.infer<typeof httpToolSchema>;
type ToolParameter = HttpTool["parameters"][number];

/** A string the model fills in is a word or a reference, never a document. */
export const MAX_ARGUMENT_CHARS = 500;

export function findHttpTool(config: Record<string, unknown>, name: string): HttpTool | null {
  const tools = z
    .array(httpToolSchema)
    .catch([])
    .parse(config.httpTools ?? []);
  return tools.find((tool) => tool.name === name) ?? null;
}

function argumentProblem(parameter: ToolParameter, value: unknown): string | null {
  const isEnum = parameter.type === "enum" && parameter.options.length > 0;
  if (isEnum) {
    return parameter.options.includes(value as string)
      ? null
      : `${parameter.name} must be one of ${parameter.options.join(", ")}`;
  }
  if (parameter.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : `${parameter.name} must be a number`;
  }
  if (parameter.type === "boolean") {
    return typeof value === "boolean" ? null : `${parameter.name} must be true or false`;
  }
  if (typeof value !== "string") return `${parameter.name} must be text`;
  if (value.length > MAX_ARGUMENT_CHARS) {
    return `${parameter.name} must be at most ${MAX_ARGUMENT_CHARS} characters`;
  }
  return null;
}

/** What is wrong with the model's arguments, worded for the model to correct; empty when they fit. */
export function toolArgumentProblems(tool: HttpTool, args: Record<string, unknown>): string[] {
  const known = new Set(tool.parameters.map((parameter) => parameter.name));
  const problems = Object.keys(args)
    .filter((name) => !known.has(name))
    .map((name) => `${name} is not a parameter of ${tool.name}`);
  for (const parameter of tool.parameters) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) problems.push(`${parameter.name} is required`);
      continue;
    }
    const problem = argumentProblem(parameter, value);
    if (problem) problems.push(problem);
  }
  return problems;
}
