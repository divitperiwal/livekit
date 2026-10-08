/** A thrown value as one line of text, for logs and refusals. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
