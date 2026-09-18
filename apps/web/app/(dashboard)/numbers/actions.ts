"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { SESSION_COOKIE } from "@/lib/api";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

/**
 * Points a number at an agent, or at nobody.
 *
 * The API checks that both the number and the agent belong to the session's
 * organisation, so neither half of the pairing can reach outside it.
 */
export async function assignAgent(
  numberId: string,
  agentId: string | null,
): Promise<{ error?: string }> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  try {
    const response = await fetch(`${API_URL}/api/numbers/${numberId}/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      body: JSON.stringify({ agentId }),
      cache: "no-store",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      return { error: body.error ?? "Could not save." };
    }
  } catch {
    return { error: "Could not reach the server." };
  }

  revalidatePath("/numbers");
  return {};
}
