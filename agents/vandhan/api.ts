// Signs in to the control plane's dashboard API as the seeded owner, the same
// way the dashboard does, and finds the VanDhan agent by its slug.

export const API = process.env.API_URL ?? "http://localhost:3000/api";
export const SLUG = "vandhan";

const login = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.SEED_EMAIL ?? "owner@kbsmotors.test",
    password: process.env.SEED_PASSWORD ?? "automitra-dev",
  }),
});
if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`);
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

export async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json as any;
}

export async function agentId(): Promise<string> {
  const { agents } = await call("GET", "/agents");
  const agent = (agents as any[]).find((a) => a.slug === SLUG);
  if (!agent) throw new Error(`no agent with slug "${SLUG}": create one named VanDhan in the dashboard first`);
  return agent.id;
}
