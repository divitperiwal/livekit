import type { Context } from "hono";
import type { z } from "zod";
import type { PlivoFile } from "../modules/numbers/plivo";
import { HttpError } from "./errors";

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export async function parseJsonBody<Schema extends z.ZodType>(
  c: Context,
  schema: Schema,
): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, `invalid body: ${describeIssues(result.error)}`);
  return result.data;
}

export function parseQuery<Schema extends z.ZodType>(c: Context, schema: Schema): z.output<Schema> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw new HttpError(400, `invalid query: ${describeIssues(result.error)}`);
  return result.data;
}

export type FormBody = Record<string, string | File | (string | File)[]>;

export async function parseFormBody(c: Context): Promise<FormBody> {
  try {
    return await c.req.parseBody();
  } catch {
    throw new HttpError(400, "body must be multipart/form-data");
  }
}

export function formFile(body: FormBody, field: string): PlivoFile {
  const value = body[field];
  if (!(value instanceof File)) throw new HttpError(400, `${field}: a file is required`);
  return { fileName: value.name || field, content: value };
}

export function formText(body: FormBody, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}
