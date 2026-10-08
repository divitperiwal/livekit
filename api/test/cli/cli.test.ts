import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { runCli } from "../../src/cli";
import {
  accounts,
  apiKeys,
  calls,
  phoneNumbers,
  rateCards,
  webhookEndpoints,
} from "../../src/db/schema";
import { hashApiKey } from "../../src/modules/keys/api-keys";
import { SEED_RATE_CARD } from "../../src/modules/billing/rate-cards";
import { seedAgentWithVersion, seedCallWithUsage, seedOrg } from "../db/seed";
import { createTestDatabase } from "../db/test-database";
import { testSecretBox } from "../fixtures/secrets";

async function createCli(roomEnder: (room: string) => Promise<void> = async () => {}) {
  const { db } = await createTestDatabase();
  const endedRooms: string[] = [];
  let lines: string[] = [];
  const run = async (...argv: string[]) => {
    lines = [];
    const code = await runCli(argv, {
      db,
      secretBox: testSecretBox,
      roomEnder: () => async (room) => {
        await roomEnder(room);
        endedRooms.push(room);
      },
      out: (line) => lines.push(line),
      operator: "cli:test",
      now: () => new Date("2026-10-05T06:30:00Z"),
      checkWebhookUrl: async (url) => {
        if (!url.startsWith("https://") || url.includes("169.254.")) {
          throw new Error("not a public https URL");
        }
      },
    });
    return { code, output: lines.join("\n") };
  };
  return { db, run, endedRooms };
}

async function accountRow(db: Awaited<ReturnType<typeof createCli>>["db"], slug: string) {
  const [account] = await db.select().from(accounts).where(eq(accounts.slug, slug));
  return account!;
}

describe("account", () => {
  test("create and show a postpaid client", async () => {
    const { run } = await createCli();
    const created = await run(
      "account",
      "create",
      "acme",
      "--name",
      "Acme Calls",
      "--credit-cap",
      "20000",
      "--daily-cap",
      "2000",
    );
    expect(created.code).toBe(0);
    expect(created.output).toContain("created account acme");
    const shown = await run("account", "show", "acme");
    expect(shown.output).toMatch(/creditCapInr\s+20000\.00/);
    expect(shown.output).toMatch(/unpaidInr\s+0/);
  });

  test("automitra's balance URL is stored with its secret encrypted", async () => {
    const { run, db } = await createCli();
    const { code } = await run(
      "account",
      "create",
      "automitra",
      "--name",
      "automitra",
      "--balance-url",
      "https://api.automitra.example/balance",
      "--balance-secret",
      "s3cret",
    );
    expect(code).toBe(0);
    const account = await accountRow(db, "automitra");
    expect(account.balanceCheckSecretCiphertext).not.toContain("s3cret");
    expect(testSecretBox.decrypt(account.balanceCheckSecretCiphertext!)).toBe("s3cret");
  });

  test("refuses a bad slug, a duplicate, a non-https balance URL or a URL without its secret", async () => {
    const { run } = await createCli();
    expect((await run("account", "create", "Acme!", "--name", "x")).code).toBe(1);
    await run("account", "create", "acme", "--name", "Acme");
    expect((await run("account", "create", "acme", "--name", "Acme")).output).toContain(
      "already exists",
    );
    expect(
      (
        await run(
          "account",
          "create",
          "b2",
          "--name",
          "B",
          "--balance-url",
          "http://x.example",
          "--balance-secret",
          "s",
        )
      ).output,
    ).toContain("https");
    expect(
      (await run("account", "create", "b3", "--name", "B", "--balance-url", "https://x.example"))
        .output,
    ).toContain("go together");
  });

  test("limits change only what is named; none removes a limit", async () => {
    const { run, db } = await createCli();
    await run(
      "account",
      "create",
      "acme",
      "--name",
      "Acme",
      "--credit-cap",
      "100",
      "--daily-cap",
      "50",
    );
    await run("account", "limits", "acme", "--daily-cap", "none");
    const account = await accountRow(db, "acme");
    expect(account.creditCapInr).toBe("100.00");
    expect(account.dailyCapInr).toBeNull();
  });

  test("a payment lowers unpaid usage, and the same reference is recorded once", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "acme", "--name", "Acme", "--credit-cap", "100");
    const account = await accountRow(db, "acme");
    const org = await seedOrg(db, account.id);
    const { agent, version } = await seedAgentWithVersion(db, org.id);
    await seedCallWithUsage(
      db,
      { accountId: account.id, orgId: org.id, agentId: agent.id, agentVersionId: version.id },
      "80.00",
    );

    const paid = await run(
      "account",
      "payment",
      "--account",
      "acme",
      "--amount",
      "50",
      "--ref",
      "NEFT-123",
    );
    expect(paid.output).toContain("recorded ₹50 from acme");
    expect(paid.output).toMatch(/unpaidInr\s+30/);
    const again = await run(
      "account",
      "payment",
      "--account",
      "acme",
      "--amount",
      "50",
      "--ref",
      "NEFT-123",
    );
    expect(again.output).toContain("already recorded");
    expect(again.output).toMatch(/unpaidInr\s+30/);
    expect(
      (await run("account", "payment", "--account", "acme", "--amount", "-5", "--ref", "x")).code,
    ).toBe(1);
  });

  test("an adjustment can debit or credit, with a reason", async () => {
    const { run } = await createCli();
    await run("account", "create", "acme", "--name", "Acme");
    expect(
      (
        await run(
          "account",
          "adjust",
          "--account",
          "acme",
          "--amount=-12.50",
          "--ref",
          "fix-1",
          "--reason",
          "missed call",
        )
      ).output,
    ).toMatch(/unpaidInr\s+12\.5/);
    expect(
      (await run("account", "adjust", "--account", "acme", "--amount", "5", "--ref", "fix-2"))
        .output,
    ).toContain("--reason is required");
  });

  test("suspend stops new calls and, when asked, ends the live ones", async () => {
    const { run, db, endedRooms } = await createCli();
    await run("account", "create", "acme", "--name", "Acme");
    const account = await accountRow(db, "acme");
    const org = await seedOrg(db, account.id);
    const { agent, version } = await seedAgentWithVersion(db, org.id);
    await db.insert(calls).values({
      orgId: org.id,
      agentId: agent.id,
      agentVersionId: version.id,
      lkJobId: "AJ_1",
      lkRoomName: "call-room-live",
      direction: "inbound",
      status: "in_progress",
    });

    const warned = await run("account", "suspend", "acme");
    expect(warned.output).toContain("1 live call(s) continue");
    expect((await accountRow(db, "acme")).status).toBe("suspended");
    expect(endedRooms).toEqual([]);

    expect((await run("account", "suspend", "acme", "--end-live-calls")).output).toContain(
      "ended 1 of 1",
    );
    expect(endedRooms).toEqual(["call-room-live"]);

    await run("account", "resume", "acme");
    expect((await accountRow(db, "acme")).status).toBe("active");
  });

  test("a live call that cannot be ended fails the command", async () => {
    const { run, db } = await createCli(async () => {
      throw new Error("livekit down");
    });
    await run("account", "create", "acme", "--name", "Acme");
    const account = await accountRow(db, "acme");
    const org = await seedOrg(db, account.id);
    const { agent, version } = await seedAgentWithVersion(db, org.id);
    await db.insert(calls).values({
      orgId: org.id,
      agentId: agent.id,
      agentVersionId: version.id,
      lkJobId: "AJ_1",
      lkRoomName: "room",
      direction: "inbound",
      status: "in_progress",
    });
    const result = await run("account", "suspend", "acme", "--end-live-calls");
    expect(result.code).toBe(1);
    expect(result.output).toContain("could not be ended");
  });
});

describe("key", () => {
  test("a key is shown once and only its hash is stored", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    const { code, output } = await run(
      "key",
      "create",
      "--account",
      "automitra",
      "--name",
      "main api",
      "--max-concurrent-calls",
      "5",
    );
    expect(code).toBe(0);
    const key = output.match(/am_live_[A-Za-z0-9_-]{43}/)![0];
    const [stored] = await db.select().from(apiKeys);
    expect(stored).toMatchObject({
      keyHash: hashApiKey(key),
      prefix: key.slice(0, 16),
      maxConcurrentCalls: 5,
      scopes: ["orgs:read", "orgs:write", "calls:read", "calls:write"],
    });
    expect(JSON.stringify(stored)).not.toContain(key);

    const listed = await run("key", "list", "--account", "automitra");
    expect(listed.output).toContain(stored!.prefix);
    expect(listed.output).not.toContain(key);
  });

  test("revoke and concurrency act by prefix", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    const { output } = await run("key", "create", "--account", "automitra", "--name", "main");
    const prefix = output.match(/am_live_[A-Za-z0-9_-]{8}/)![0];

    expect((await run("key", "concurrency", prefix, "3")).output).toContain("3 live call(s)");
    expect((await run("key", "concurrency", prefix, "0")).code).toBe(1);
    expect((await run("key", "revoke", prefix)).code).toBe(0);
    expect((await run("key", "revoke", prefix)).output).toContain("no live key");
    const [stored] = await db.select().from(apiKeys);
    expect(stored).toMatchObject({ maxConcurrentCalls: 3 });
    expect(stored!.revokedAt).not.toBeNull();
  });

  test("refuses unknown scopes", async () => {
    const { run } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    expect(
      (
        await run(
          "key",
          "create",
          "--account",
          "automitra",
          "--name",
          "x",
          "--scopes",
          "calls:read,admin",
        )
      ).output,
    ).toContain("unknown scope(s) admin");
  });
});

describe("rate-card", () => {
  test("seeding puts the spec's card in effect; a new card closes the old one", async () => {
    const { run, db } = await createCli();
    expect((await run("rate-card", "seed", "--from", "2026-10-01T00:00:00+05:30")).code).toBe(0);

    const file = join(mkdtempSync(join(tmpdir(), "rates-")), "rates.json");
    writeFileSync(
      file,
      JSON.stringify({ ...SEED_RATE_CARD, sell: { kind: "per_minute", inrPerMinute: 5 } }),
    );
    expect(
      (
        await run(
          "rate-card",
          "add",
          "--name",
          "november",
          "--file",
          file,
          "--from",
          "2026-11-01T00:00:00+05:30",
        )
      ).code,
    ).toBe(0);

    const cards = await db.select().from(rateCards).where(isNull(rateCards.accountId));
    const seed = cards.find((card) => card.name === "seed")!;
    const november = cards.find((card) => card.name === "november")!;
    expect(seed.effectiveTo?.toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(november.effectiveTo).toBeNull();
  });

  test("an account's own card, and an invalid card is refused with the reason", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "acme", "--name", "Acme");
    const file = join(mkdtempSync(join(tmpdir(), "rates-")), "rates.json");
    writeFileSync(file, JSON.stringify(SEED_RATE_CARD));
    expect(
      (await run("rate-card", "add", "--name", "acme-2026", "--file", file, "--account", "acme"))
        .code,
    ).toBe(0);
    expect(
      await db.$count(rateCards, eq(rateCards.accountId, (await accountRow(db, "acme")).id)),
    ).toBe(1);

    writeFileSync(file, JSON.stringify({ ...SEED_RATE_CARD, minimumSeconds: -1 }));
    const refused = await run("rate-card", "add", "--name", "bad", "--file", file);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("minimumSeconds");
  });
});

describe("number", () => {
  test("numbers join the pool once, unassigned", async () => {
    const { run, db } = await createCli();
    expect((await run("number", "add", "+918045001234", "+918045001235")).output).toContain(
      "added +918045001235",
    );
    expect((await run("number", "add", "+918045001234")).output).toContain("already on file");
    expect((await run("number", "add", "08045001234")).code).toBe(1);
    expect(await db.$count(phoneNumbers, eq(phoneNumbers.status, "available"))).toBe(2);
  });
});

describe("webhook", () => {
  test("an endpoint gets a secret shown once, stored encrypted", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    const { code, output } = await run(
      "webhook",
      "add",
      "--account",
      "automitra",
      "--url",
      "https://api.automitra.example/hooks/voice",
    );
    expect(code).toBe(0);
    const secret = output.match(/whsec_[A-Za-z0-9_-]{43}/)![0];
    const [endpoint] = await db.select().from(webhookEndpoints);
    expect(endpoint).toMatchObject({
      events: ["call.ended", "usage.recorded", "account.credit_low"],
      enabled: true,
      orgId: null,
    });
    expect(testSecretBox.decrypt(endpoint!.secretCiphertext)).toBe(secret);
    expect((await run("webhook", "list", "--account", "automitra")).output).not.toContain(secret);
  });

  test("refuses a non-public URL, an unknown event or an org the account does not have", async () => {
    const { run } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    expect(
      (await run("webhook", "add", "--account", "automitra", "--url", "https://169.254.169.254/"))
        .output,
    ).toContain("--url refused");
    expect(
      (
        await run(
          "webhook",
          "add",
          "--account",
          "automitra",
          "--url",
          "https://x.example",
          "--events",
          "call.started",
        )
      ).output,
    ).toContain("unknown event(s) call.started");
    expect(
      (
        await run(
          "webhook",
          "add",
          "--account",
          "automitra",
          "--url",
          "https://x.example",
          "--org",
          "nope",
        )
      ).output,
    ).toContain('no org "nope"');
  });

  test("disable and enable by id", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    await run("webhook", "add", "--account", "automitra", "--url", "https://x.example/h");
    const [endpoint] = await db.select().from(webhookEndpoints);
    expect((await run("webhook", "disable", "--account", "automitra", endpoint!.id)).code).toBe(0);
    expect((await db.select().from(webhookEndpoints))[0]!.enabled).toBe(false);
    expect(
      (await run("webhook", "enable", "--account", "automitra", endpoint!.id)).output,
    ).toContain("queued events will be delivered");
    expect(
      (await run("webhook", "disable", "--account", "automitra", crypto.randomUUID())).code,
    ).toBe(1);
  });
});

test("help lists the commands; an unknown group fails", async () => {
  const { run } = await createCli();
  expect((await run("help")).output).toContain("account payment --account <slug>");
  expect((await run("frobnicate")).code).toBe(1);
});
