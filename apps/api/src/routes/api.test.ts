/**
 * The dashboard's API.
 *
 * The tests that matter here are the isolation ones. Every route is scoped to
 * the signed-in session's organisation, and a route that can be talked into
 * returning another tenant's rows is the bug class that ends a business --
 * which is not something a type system catches.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import {
  agents,
  agentVersions,
  calls,
  orgBalances,
  orgMembers,
  orgs,
  phoneNumbers,
  users,
} from "../db/schema";
import { apiRoutes } from "./api";

const { sql, db } = createClient({ max: 2 });
const app = apiRoutes(db);

const PASSWORD = "test-password-1234";

const fx = {
  orgA: "", orgB: "",
  agentA: "", agentB: "",
  callA: "", callB: "",
  numberA: "",
  emailA: "", emailB: "",
  cookieA: "", cookieB: "",
};

async function login(email: string): Promise<string> {
  const response = await app.request("http://api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

function as(cookie: string, path: string, init: RequestInit = {}) {
  return app.request(`http://api${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
}

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });

  for (const key of ["A", "B"] as const) {
    const lower = key.toLowerCase();
    const org = (
      await db.insert(orgs).values({ name: `Org ${key}`, slug: `${lower}-${suffix}` }).returning()
    )[0]!;
    const email = `${lower}-${suffix}@test.local`;
    const user = (
      await db.insert(users).values({ email, passwordHash: hash }).returning()
    )[0]!;
    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
    await db.insert(orgBalances).values({ orgId: org.id, balanceInr: "500" });

    const agent = (
      await db
        .insert(agents)
        .values({ orgId: org.id, name: `Agent ${key}`, slug: `agent-${lower}-${suffix}` })
        .returning()
    )[0]!;

    const version = (
      await db
        .insert(agentVersions)
        .values({
          agentId: agent.id,
          orgId: org.id,
          version: 1,
          instructions: `Prompt ${key}`,
          greeting: `Greeting ${key}`,
          config: {},
          publishedAt: new Date(),
        })
        .returning()
    )[0]!;
    await db.update(agents).set({ liveVersionId: version.id }).where(eq(agents.id, agent.id));

    const call = (
      await db
        .insert(calls)
        .values({
          orgId: org.id,
          agentId: agent.id,
          agentVersionId: version.id,
          lkRoomName: `room-${lower}`,
          lkJobId: `JOB_${lower}_${suffix}`,
          direction: "inbound",
          status: "completed",
          startedAt: new Date(),
        })
        .returning()
    )[0]!;

    fx[`org${key}`] = org.id;
    fx[`agent${key}`] = agent.id;
    fx[`call${key}`] = call.id;
    fx[`email${key}`] = email;
  }

  const number = (
    await db
      .insert(phoneNumbers)
      .values({
        orgId: fx.orgA,
        e164: `+9155${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        agentId: fx.agentA,
        status: "assigned",
      })
      .returning()
  )[0]!;
  fx.numberA = number.id;

  fx.cookieA = await login(fx.emailA);
  fx.cookieB = await login(fx.emailB);
});

afterAll(async () => {
  for (const id of [fx.orgA, fx.orgB]) {
    await db.delete(orgs).where(eq(orgs.id, id)).catch(() => {});
  }
  await db.delete(users).where(eq(users.email, fx.emailA)).catch(() => {});
  await db.delete(users).where(eq(users.email, fx.emailB)).catch(() => {});
  await Promise.allSettled([sql.end(), closeRedis()]);
});

describe("signing in", () => {
  test("a correct password returns a session cookie", () => {
    expect(fx.cookieA).toContain("automitra_session=");
  });

  test("a wrong password is refused", async () => {
    const response = await app.request("http://api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fx.emailA, password: "wrong" }),
    });
    expect(response.status).toBe(401);
  });

  test("an unknown address gives the same answer as a wrong password", async () => {
    // Telling them apart turns the login form into a way to find out who has
    // an account here.
    const unknown = await app.request("http://api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@nowhere.test", password: "wrong" }),
    });
    const wrong = await app.request("http://api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fx.emailA, password: "wrong" }),
    });

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  test("the cookie is not readable from JavaScript", async () => {
    // The whole point of httpOnly: a cross-site script cannot steal it.
    const response = await app.request("http://api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fx.emailA, password: PASSWORD }),
    });
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
  });
});

describe("every route needs a session", () => {
  for (const path of ["/me", "/calls", "/agents", "/numbers", "/usage"]) {
    test(`${path} refuses an anonymous request`, async () => {
      const response = await app.request(`http://api${path}`);
      expect(response.status).toBe(401);
    });
  }

  test("a made-up cookie is not a session", async () => {
    const response = await as("automitra_session=not-a-real-session", "/calls");
    expect(response.status).toBe(401);
  });
});

describe("tenant isolation", () => {
  test("a list shows only the signed-in organisation's rows", async () => {
    const response = await as(fx.cookieA, "/agents");
    const body = (await response.json()) as { agents: Array<{ id: string }> };
    const ids = body.agents.map((a) => a.id);
    expect(ids).toContain(fx.agentA);
    expect(ids).not.toContain(fx.agentB);
  });

  test("another organisation's call is not readable by id", async () => {
    // A leaked or guessed id must not be enough on its own.
    const response = await as(fx.cookieA, `/calls/${fx.callB}`);
    expect(response.status).toBe(404);
  });

  test("another organisation's agent is not readable by id", async () => {
    const response = await as(fx.cookieA, `/agents/${fx.agentB}`);
    expect(response.status).toBe(404);
  });

  test("your own call is readable", async () => {
    const response = await as(fx.cookieA, `/calls/${fx.callA}`);
    expect(response.status).toBe(200);
  });

  test("publishing to another organisation's agent is refused", async () => {
    const response = await as(fx.cookieA, `/agents/${fx.agentB}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "mine now", greeting: "hello" }),
    });
    expect(response.status).toBe(404);
  });

  test("a number cannot be pointed at another organisation's agent", async () => {
    // Both halves of the pairing are checked, not just the number.
    const response = await as(fx.cookieA, `/numbers/${fx.numberA}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: fx.agentB }),
    });
    expect(response.status).toBe(404);
  });

  test("switching to an organisation you do not belong to is refused", async () => {
    const response = await as(fx.cookieA, "/me/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: fx.orgB }),
    });
    expect(response.status).toBe(403);
  });
});

describe("publishing an agent version", () => {
  test("writes a new version and moves the pointer", async () => {
    const response = await as(fx.cookieA, `/agents/${fx.agentA}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: "You are helpful.",
        greeting: "Say hello.",
        promptMode: "verbatim",
        config: { ttsSpeaker: "ritu" },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: number };
    expect(body.version).toBe(2);

    const detail = await as(fx.cookieA, `/agents/${fx.agentA}`);
    const agent = (await detail.json()) as { live: { version: number; promptMode: string } };
    expect(agent.live.version).toBe(2);
    expect(agent.live.promptMode).toBe("verbatim");
  });

  test("an invalid configuration is rejected with the field that is wrong", async () => {
    // The same validation the worker applies. Rejected here, in a form, rather
    // than at three in the morning on a live call.
    const response = await as(fx.cookieA, `/agents/${fx.agentA}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: "x",
        greeting: "y",
        config: { ttsModel: "bulbul:v3", ttsSpeaker: "anushka" },
      }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fields: Record<string, string> };
    expect(body.fields.ttsSpeaker).toContain("not a voice on bulbul:v3");
  });

  test("an empty prompt is refused", async () => {
    const response = await as(fx.cookieA, `/agents/${fx.agentA}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "   ", greeting: "hello" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("usage", () => {
  test("reports the balance and whether calls may be placed", async () => {
    const response = await as(fx.cookieA, "/usage");
    const body = (await response.json()) as {
      balanceInr: number;
      canPlaceCalls: boolean;
    };
    expect(body.balanceInr).toBeCloseTo(500, 2);
    expect(body.canPlaceCalls).toBe(true);
  });
});

describe("signing out", () => {
  test("ends the session immediately", async () => {
    // Sessions live in Redis rather than in a signed token, so signing out
    // takes effect now rather than whenever the token would have expired.
    const cookie = await login(fx.emailA);
    expect((await as(cookie, "/me")).status).toBe(200);

    await as(cookie, "/auth/logout", { method: "POST" });
    expect((await as(cookie, "/me")).status).toBe(401);
  });
});
