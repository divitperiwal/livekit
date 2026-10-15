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
  orgs,
  phoneNumbers,
  rateCards,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvent,
} from "../../src/db/schema";
import { hashApiKey } from "../../src/modules/keys/api-keys";
import { SEED_RATE_CARD } from "../../src/modules/billing/rate-cards";
import { seedAgentWithVersion, seedCallWithUsage, seedOrg } from "../db/seed";
import { createTestDatabase } from "../db/test-database";
import { FakePlivo } from "../fixtures/fake-plivo";
import { testSecretBox } from "../fixtures/secrets";

async function createCli(roomEnder: (room: string) => Promise<void> = async () => {}) {
  const { db } = await createTestDatabase();
  const plivo = new FakePlivo();
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
      plivo: () => plivo,
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
  return { db, run, endedRooms, plivo };
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

  test("tool-secret sets the account's signing secret, shown once, and replaces it", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "marcofed", "--name", "MARCOFED");
    expect((await run("account", "show", "marcofed")).output).toMatch(/toolSecret\s+none/);

    const first = await run("account", "tool-secret", "marcofed");
    expect(first.code).toBe(0);
    const secret = first.output.match(/tsec_[\w-]+/)![0];
    const account = await accountRow(db, "marcofed");
    expect(account.toolSecretCiphertext).not.toContain(secret);
    expect(testSecretBox.decrypt(account.toolSecretCiphertext!)).toBe(secret);
    expect(first.output).not.toContain("stopped working");
    expect((await run("account", "show", "marcofed")).output).toMatch(/toolSecret\s+set/);

    const second = await run("account", "tool-secret", "marcofed");
    expect(second.output).toContain("the old secret stopped working now");
    const replaced = await accountRow(db, "marcofed");
    expect(testSecretBox.decrypt(replaced.toolSecretCiphertext!)).not.toBe(secret);
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
      events: [...webhookEvent.enumValues],
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

describe("key scopes", () => {
  test("numbers:rent is granted only when asked for", async () => {
    const { run, db } = await createCli();
    await run("account", "create", "automitra", "--name", "automitra");
    const { output } = await run("key", "create", "--account", "automitra", "--name", "main");
    const prefix = output.match(/am_live_[A-Za-z0-9_-]{8}/)![0];

    const granted = await run("key", "scopes", prefix, "orgs:read,orgs:write,numbers:rent");
    expect(granted.output).toContain("now has orgs:read,orgs:write,numbers:rent");
    const [stored] = await db.select().from(apiKeys);
    expect(stored!.scopes).toEqual(["orgs:read", "orgs:write", "numbers:rent"]);
    expect((await run("key", "scopes", prefix, "numbers:buy")).output).toContain(
      "unknown scope(s) numbers:buy",
    );
  });
});

/** An account with one org and an endpoint subscribed to the number events. */
async function managedBusiness() {
  const cli = await createCli();
  await cli.run("account", "create", "marcofed", "--name", "Marcofed");
  const account = await accountRow(cli.db, "marcofed");
  const org = await seedOrg(cli.db, account.id, "clinic-1");
  await cli.db.insert(webhookEndpoints).values({
    accountId: account.id,
    url: "https://marcofed.example/hooks",
    secretCiphertext: "x",
    events: ["number_kyc.updated", "number.released"],
  });
  const directory = mkdtempSync(join(tmpdir(), "kyc-"));
  const registration = join(directory, "incorporation.pdf");
  const gst = join(directory, "gst.png");
  writeFileSync(registration, "%PDF-1.7");
  writeFileSync(gst, "PNG");
  const submitKyc = (...extra: string[]) =>
    cli.run(
      "org",
      "kyc",
      "submit",
      "--account",
      "marcofed",
      "--org",
      "clinic-1",
      "--legal-name",
      "Sharma Dental Clinic Pvt Ltd",
      "--gstin",
      "29ABCDE1234F1Z5",
      "--address",
      "12 MG Road",
      "--city",
      "Bengaluru",
      "--state",
      "Karnataka",
      "--pin",
      "560001",
      "--registration-certificate",
      registration,
      "--gst-certificate",
      gst,
      ...extra,
    );
  const kycStatus = () =>
    cli.run("org", "kyc", "status", "--account", "marcofed", "--org", "clinic-1");
  const orgRow = async () => (await cli.db.select().from(orgs).where(eq(orgs.id, org.id)))[0]!;
  const queued = (event: "number_kyc.updated" | "number.released") =>
    cli.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.event, event));
  return { ...cli, org, submitKyc, kycStatus, orgRow, queued };
}

describe("org kyc", () => {
  test("submit sends the documents to Plivo and keeps only the status", async () => {
    const { submitKyc, orgRow, plivo, queued } = await managedBusiness();
    const { code, output } = await submitKyc();
    expect(code).toBe(0);
    expect(output).toContain("submitted to Plivo as compliance-1");

    const sent = plivo.applications.get("compliance-1")!.application;
    expect(sent.business).toMatchObject({
      name: "Sharma Dental Clinic Pvt Ltd",
      registrationNumber: "29ABCDE1234F1Z5",
    });
    expect(sent.documents.map((document) => document.documentTypeId)).toEqual([
      "doc-registration-certificate",
      "doc-gst-certificate",
    ]);
    expect(sent.documents[0]!.dataFields).toEqual({
      business_name: "Sharma Dental Clinic Pvt Ltd",
    });
    expect(sent.documents.map((document) => document.file.fileName)).toEqual([
      "incorporation.pdf",
      "gst.png",
    ]);
    expect(await orgRow()).toMatchObject({
      numberKycStatus: "submitted",
      numberKycApplicationId: "compliance-1",
    });
    const [event] = await queued("number_kyc.updated");
    expect(event!.payload).toEqual({
      orgId: "clinic-1",
      status: "submitted",
      rejectionReason: null,
    });
  });

  test("bad business details and a second submission while under review are refused", async () => {
    const { submitKyc, plivo } = await managedBusiness();
    expect((await submitKyc("--gstin", "NOT-A-GSTIN")).output).toContain("gstin");
    expect(plivo.calls).not.toContain("submitKyc");
    await submitKyc();
    expect((await submitKyc()).output).toContain("already with Plivo");
  });

  test("status stores Plivo's decision; a rejection is fixed on the same application", async () => {
    const { submitKyc, kycStatus, orgRow, plivo, queued } = await managedBusiness();
    await submitKyc();
    plivo.decideKyc("compliance-1", "rejected", "GST name mismatch");

    const rejected = await kycStatus();
    expect(rejected.output).toContain("rejected");
    expect(rejected.output).toContain("GST name mismatch");
    expect((await kycStatus()).output).toMatch(/changedNow\s+false/);

    await submitKyc();
    expect(plivo.calls.filter((call) => call === "resubmitKyc")).toHaveLength(1);
    plivo.decideKyc("compliance-1", "accepted");
    await kycStatus();
    expect(await orgRow()).toMatchObject({
      numberKycStatus: "accepted",
      numberKycApplicationId: "compliance-1",
      numberKycRejectionReason: null,
    });
    const statuses = (await queued("number_kyc.updated")).map((row) => row.payload.status);
    expect(statuses).toEqual(["submitted", "rejected", "submitted", "accepted"]);
  });

  test("a suspended application is lifted with consent proof, not new documents", async () => {
    const { submitKyc, kycStatus, plivo } = await managedBusiness();
    await submitKyc();
    plivo.decideKyc("compliance-1", "suspended");
    await kycStatus();
    expect((await submitKyc()).output).toContain("consent proof");
  });

  test("after expiry a new application is filed, and on acceptance the numbers move under it", async () => {
    const { run, submitKyc, kycStatus, orgRow, plivo } = await managedBusiness();
    plivo.holdManaged("+918045001234");
    await run("number", "add", "+918045001234");
    await submitKyc();
    plivo.decideKyc("compliance-1", "accepted");
    await kycStatus();
    await run("number", "assign", "+918045001234", "--account", "marcofed", "--org", "clinic-1");

    plivo.decideKyc("compliance-1", "expired");
    await kycStatus();
    expect((await submitKyc()).output).toContain("compliance-2");
    plivo.decideKyc("compliance-2", "accepted");
    await kycStatus();

    expect(await orgRow()).toMatchObject({ numberKycApplicationId: "compliance-2" });
    expect(plivo.held.get("+918045001234")!.complianceApplicationId).toBe("compliance-2");
  });
});

describe("number assign and unassign", () => {
  test("a pool number goes only to a business with accepted KYC, under its application", async () => {
    const { run, db, submitKyc, kycStatus, plivo } = await managedBusiness();
    plivo.holdManaged("+918045001234");
    await run("number", "add", "+918045001234");
    const assign = () =>
      run("number", "assign", "+918045001234", "--account", "marcofed", "--org", "clinic-1");

    expect((await assign()).output).toContain("number KYC not accepted");
    await submitKyc();
    plivo.decideKyc("compliance-1", "accepted");
    await kycStatus();

    expect((await assign()).code).toBe(0);
    expect(plivo.held.get("+918045001234")!.complianceApplicationId).toBe("compliance-1");
    const [number] = await db.select().from(phoneNumbers);
    expect(number).toMatchObject({ status: "assigned", source: "managed" });
    expect((await assign()).output).toContain("not an available pool number");
  });

  test("unassign releases the number to Plivo and tells the account", async () => {
    const { run, db, submitKyc, kycStatus, plivo, queued } = await managedBusiness();
    plivo.holdManaged("+918045001234");
    await run("number", "add", "+918045001234");
    await submitKyc();
    plivo.decideKyc("compliance-1", "accepted");
    await kycStatus();
    await run("number", "assign", "+918045001234", "--account", "marcofed", "--org", "clinic-1");

    expect((await run("number", "unassign", "+918045001234")).output).toContain("released");
    expect(plivo.held.has("+918045001234")).toBe(false);
    const [number] = await db.select().from(phoneNumbers);
    expect(number).toMatchObject({ status: "released", agentId: null });
    expect(number!.releasedAt).not.toBeNull();
    const [event] = await queued("number.released");
    expect(event!.payload).toEqual({ orgId: "clinic-1", number: "+918045001234" });
    expect((await run("number", "unassign", "+918045001234")).output).toContain(
      "not held by any business",
    );
  });

  test("when Plivo fails, the number stops answering and stays releasing for a retry", async () => {
    const { run, db, submitKyc, kycStatus, plivo } = await managedBusiness();
    plivo.holdManaged("+918045001234");
    await run("number", "add", "+918045001234");
    await submitKyc();
    plivo.decideKyc("compliance-1", "accepted");
    await kycStatus();
    await run("number", "assign", "+918045001234", "--account", "marcofed", "--org", "clinic-1");

    plivo.failNext("releaseNumber");
    expect((await run("number", "unassign", "+918045001234")).output).toContain("will be retried");
    const [number] = await db.select().from(phoneNumbers);
    expect(number).toMatchObject({ status: "releasing", agentId: null, releasedAt: null });
  });
});
