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

import { eq } from "drizzle-orm";

import { DEFAULT_AGENT_CONFIG } from "./agent-config";
import { createClient } from "./client";
import { validateAgentConfig } from "./validate-config";
import {
  agents,
  agentVersions,
  orgBalances,
  orgs,
  rateCards,
} from "./schema";

const WORKER_SEED_DIR = join(
  import.meta.dir,
  "../../../../worker/src/automitra_worker/seed_personas",
);

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
  // Rs 6/min against a cost of roughly Rs 2.30-3.70/min, depending on how
  // much of the call the agent does the talking -- text-to-speech is charged
  // per character and is the largest component, so a monologue costs nearly
  // twice what a two-sided conversation does.
  //
  // That leaves a thin margin at the talkative end and none at all if an agent
  // speaks continuously. Worth revisiting once real calls show the actual
  // distribution, and worth remembering that the carrier figure below is still
  // an estimate rather than a reconciled number.
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
  const existingAgent = await db.query.agents.findFirst({
    where: eq(agents.slug, "simran"),
  });

  if (existingAgent) {
    console.log("agent simran (existing)");
  } else {
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

    const version = (
      await db
        .insert(agentVersions)
        .values({
          agentId: agent.id,
          orgId: org.id,
          version: 1,
          // The script sets its own language, brevity and identity rules, so
          // the shared voice rules must not be prepended: they open with "You
          // are a voice assistant", which this agent is explicitly forbidden
          // from implying.
          promptMode: "verbatim",
          instructions: workerSeed("kbs.prompt.txt"),
          greeting: workerSeed("kbs.greeting.txt"),
          // Through the same validation a customer's save goes through. A
          // seed that bypassed it could plant a configuration the worker
          // would reject at call time.
          config: validateAgentConfig(DEFAULT_AGENT_CONFIG),
          publishedAt: new Date(),
        })
        .returning()
    )[0]!;

    await db
      .update(agents)
      .set({ liveVersionId: version.id, draftVersionId: version.id })
      .where(eq(agents.id, agent.id));

    console.log(
      `agent simran (created) v${version.version}, ` +
        `${version.instructions.length} chars of prompt`,
    );
  }

  console.log("seed complete");
} finally {
  await sql.end();
}
