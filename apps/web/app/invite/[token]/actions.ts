"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "@/lib/api";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

export interface AcceptState {
  error?: string;
}

/**
 * Accepts an invitation, then signs in exactly as the login form does:
 * copying the API's session cookie onto this response.
 */
export async function accept(_previous: AcceptState, formData: FormData): Promise<AcceptState> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/auth/accept-invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: String(formData.get("token") ?? ""),
        password: String(formData.get("password") ?? ""),
        name: String(formData.get("name") ?? "").trim() || undefined,
      }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the server." };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { error: body.error ?? "That did not work." };
  }

  const value = (response.headers.get("set-cookie") ?? "").split(";")[0]?.split("=").slice(1).join("=");
  if (!value) return { error: "The server did not return a session." };
  const store = await cookies();
  store.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24,
  });
  redirect("/calls");
}
