/**
 * Writing to the control plane from a Server Action.
 *
 * The read path (`api`) throws, which suits a page: an error there is an
 * error page. A form wants the opposite -- the API's message and per-field
 * errors back as values, to show beside the box that is wrong.
 *
 * Server-only: it reads the session cookie.
 */

import { cookies } from "next/headers";

import { SESSION_COOKIE } from "./api";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

export interface MutationResult<T> {
  ok: boolean;
  body: T & { error?: string; fields?: Record<string, string> };
}

export async function mutate<T = Record<string, unknown>>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<MutationResult<T>> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  try {
    const response = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const parsed = (await response.json().catch(() => ({}))) as MutationResult<T>["body"];
    if (!response.ok && !parsed.error) parsed.error = `request failed with ${response.status}`;
    return { ok: response.ok, body: parsed };
  } catch {
    return { ok: false, body: { error: "Could not reach the server." } as MutationResult<T>["body"] };
  }
}
