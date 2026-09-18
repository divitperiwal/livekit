"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "@/lib/api";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

export interface LoginState {
  error?: string;
}

/**
 * Signs in and copies the API's session cookie onto this response.
 *
 * The browser talks to Next, which talks to the API, so the cookie the API
 * sets has to be re-issued here rather than passed through. Its attributes are
 * set to match what the API chose: httpOnly so a script cannot read it, lax so
 * it does not ride along on cross-site requests.
 */
export async function login(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/calls");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the server. Is the API running?" };
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { error: body.error ?? "That did not work." };
  }

  const setCookie = response.headers.get("set-cookie") ?? "";
  const value = setCookie.split(";")[0]?.split("=").slice(1).join("=");
  if (!value) {
    return { error: "The server did not return a session." };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24,
  });

  // Only ever a path on this site: an open redirect would let a link that
  // looks like ours land someone on a page that is not.
  redirect(next.startsWith("/") ? next : "/calls");
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  if (session) {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
      cache: "no-store",
    }).catch(() => {
      // Even if the API cannot be reached, clearing the cookie below signs
      // this browser out. The session expires on its own soon enough.
    });
  }

  store.delete(SESSION_COOKIE);
  redirect("/login");
}
