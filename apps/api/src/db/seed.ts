/**
 * Seeds a development database. `bun run db:seed`.
 *
 * The first tenant is KBS Motors, whose call script is the one real agent
 * configuration this project has. It is loaded from the worker's own seed
 * files rather than copied, so there is one source of truth for it, and it is
 * used here deliberately: a 14 KB production prompt with time-of-day branching
 * and a transfer rule finds gaps in a schema that a toy row would not.
 *
 * Idempotent. Running it twice changes nothing, so it is safe to re-run after
 * a migration.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { desc, eq } from "drizzle-orm";

import { DEFAULT_AGENT_CONFIG } from "./agent-config";
import { createClient } from "./client";
import { validateAgentConfig } from "./validate-config";
import {
  agents,
  agentVersions,
  orgBalances,
  orgMembers,
  orgs,
  rateCards,
  users,
} from "./schema";

const WORKER_SEED_DIR = join(
  import.meta.dir,
  "../../../../worker/src/automitra_worker/seed_personas",
);

/** JSON with object keys sorted: jsonb does not keep the order they were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function workerSeed(name: string): string {
  return readFileSync(join(WORKER_SEED_DIR, name), "utf8").replace(/\n+$/, "");
}

/**
 * The platform's default rate card.
 *
 * `cost` is what the platform pays its providers, at Sarvam's list prices.
 * `sell` is what a customer is charged.
 *
 * Per-minute rather than cost-plus, deliberately: a customer can forecast it,
 * and it means moving to a cheaper model is a margin improvement rather than a
 * price cut passed straight through.
 *
 * `pstn` is the carrier's charge. It is the component the platform does not
 * control, it varies by destination in ways a prefix table only approximates,
 * and the figure below is a placeholder until real carrier records are
 * reconciled against it. Margin numbers are not trustworthy before then.
 */
const DEFAULT_RATES = {
  cost: {
    sttInrPerMin: { "saaras:v4": 0.5, "saaras:v3": 0.5 },
    ttsInrPerChar: {
      "bulbul:v3": 0.003,
      "bulbul:v3-beta": 0.003,
      "bulbul:v2": 0.003,
    },
    llmInrPerMtok: {
      "sarvam-105b-conversations": { input: 29.28, output: 73.2 },
      "sarvam-105b": { input: 29.28, output: 73.2 },
      gemma4: { input: 29.28, output: 73.2 },
      "glm5.2": { input: 29.28, output: 73.2 },
    },
    llmInrCachedPerMtok: {
      "sarvam-105b-conversations": 10.98,
      "sarvam-105b": 10.98,
      gemma4: 10.98,
      "glm5.2": 10.98,
    },
    pstnInrPerMin: { "+91": 0.6, default: 3.0 },
  },
  // Rs 6/min against a cost of at most about Rs 3.60/min on an Indian number:
  // the worker holds Sarvam's share to Rs 2.50/min on every call, and to Rs 3/min
  // for the first sentence of each reply (see RateCeiling in the worker's
  // budget.py), and the carrier adds Rs 0.60.
  //
  // Worth remembering that the carrier figure above is still an estimate
  // rather than a reconciled number.
  sell: {
    mode: "per_minute" as const,
    perMinuteInr: 6.0,
    minimumSeconds: 30,
    incrementSeconds: 1,
    includedMinutesPerMonth: 0,
  },
};

const { sql, db } = createClient({ max: 1 });

try {
  // --- organisation ---------------------------------------------------------
  const existingOrg = await db.query.orgs.findFirst({
    where: eq(orgs.slug, "kbs-motors"),
  });

  const org =
    existingOrg ??
    (
      await db
        .insert(orgs)
        .values({
          name: "KBS Motors",
          slug: "kbs-motors",
          plan: "starter",
          status: "active",
        })
        .returning()
    )[0]!;

  console.log(`org ${org.slug} ${existingOrg ? "(existing)" : "(created)"}`);

  await db
    .insert(orgBalances)
    .values({ orgId: org.id, balanceInr: "1000.0000" })
    .onConflictDoNothing();

  // --- a user to sign in as -------------------------------------------------
  //
  // Development only. The password is printed rather than hidden because the
  // point is to be able to log in, and this seed never runs anywhere real.
  const SEED_EMAIL = "owner@kbsmotors.test";
  const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "automitra-dev";

  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, SEED_EMAIL),
  });

  const user =
    existingUser ??
    (
      await db
        .insert(users)
        .values({
          email: SEED_EMAIL,
          name: "KBS Owner",
          passwordHash: await Bun.password.hash(SEED_PASSWORD, {
            algorithm: "argon2id",
          }),
          emailVerifiedAt: new Date(),
        })
        .returning()
    )[0]!;

  await db
    .insert(orgMembers)
    .values({ orgId: org.id, userId: user.id, role: "owner" })
    .onConflictDoNothing();

  console.log(
    `user ${SEED_EMAIL} ${existingUser ? "(existing)" : `(created, password: ${SEED_PASSWORD})`}`,
  );

  // --- platform rate card ---------------------------------------------------
  const existingCard = await db.query.rateCards.findFirst({
    where: eq(rateCards.name, "platform-default"),
  });
  if (!existingCard) {
    await db.insert(rateCards).values({
      orgId: null, // null = applies to every organisation
      name: "platform-default",
      rates: DEFAULT_RATES,
    });
    console.log("rate card platform-default (created)");
  } else {
    console.log("rate card platform-default (existing)");
  }

  // --- the agent ------------------------------------------------------------
  // The script the seed publishes, read from the worker's seed files so there
  // is one copy of it.
  //
  // The greeting is the exact words, spoken with no model request and its
  // audio reused: as an instruction it was a cold request of the whole prompt,
  // and the longest silence of the call. The closing lines are spoken by the
  // worker, chosen by the hour; the prompt relies on them and carries none.
  //
  // The config goes through the same validation a customer's save does. A seed
  // that bypassed it could plant a configuration the worker would reject at
  // call time.
  const script = {
    // The script sets its own language, brevity and identity rules, so the
    // shared voice rules must not be prepended: they open with "You are a
    // voice assistant", which this agent is explicitly forbidden from implying.
    promptMode: "verbatim" as const,
    instructions: workerSeed("kbs.prompt.txt"),
    greeting: workerSeed("kbs.greeting.txt"),
    config: validateAgentConfig({
      ...DEFAULT_AGENT_CONFIG,
      greetingMode: "verbatim",
      closingLines: JSON.parse(workerSeed("kbs.closing.json")),
    }),
  };

  const existingAgent = await db.query.agents.findFirst({
    where: eq(agents.slug, "simran"),
  });

  if (!existingAgent) {
    const agent = (
      await db
        .insert(agents)
        .values({
          orgId: org.id,
          name: "Simran",
          slug: "simran",
          description: "Inbound enquiry desk for KBS Motors.",
        })
        .returning()
    )[0]!;
    const version = await publishScript(agent.id, 1);
    console.log(
      `agent simran (created) v${version.version}, ` +
        `${version.instructions.length} chars of prompt`,
    );
  } else {
    // A database seeded before the script changed would otherwise keep
    // running the old one. Versions are never edited, so publishing a new
    // one loses nothing: the previous version stays, and can be restored.
    const live = existingAgent.liveVersionId
      ? await db.query.agentVersions.findFirst({
          where: eq(agentVersions.id, existingAgent.liveVersionId),
        })
      : undefined;
    const current =
      live !== undefined &&
      live.promptMode === script.promptMode &&
      live.instructions === script.instructions &&
      live.greeting === script.greeting &&
      canonical(live.config) === canonical(script.config);
    if (current) {
      console.log("agent simran (existing, script current)");
    } else {
      const latest = await db.query.agentVersions.findFirst({
        where: eq(agentVersions.agentId, existingAgent.id),
        orderBy: desc(agentVersions.version),
      });
      const version = await publishScript(existingAgent.id, (latest?.version ?? 0) + 1);
      console.log(
        `agent simran (existing) published v${version.version}, ` +
          `${version.instructions.length} chars of prompt`,
      );
    }
  }

  async function publishScript(agentId: string, number: number) {
    const version = (
      await db
        .insert(agentVersions)
        .values({ agentId, orgId: org.id, version: number, ...script, publishedAt: new Date() })
        .returning()
    )[0]!;
    await db
      .update(agents)
      .set({ liveVersionId: version.id, draftVersionId: version.id })
      .where(eq(agents.id, agentId));
    return version;
  }

  console.log("seed complete");
} finally {
  await sql.end();
}
