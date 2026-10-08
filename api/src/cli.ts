/**
 * The ops CLI: the only way accounts, keys, payments, rate cards, pool numbers and webhook
 * endpoints are created. `bun src/cli.ts <group> <command> ...`; `bun src/cli.ts help` lists them.
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { and, eq } from "drizzle-orm";
import { ConfigError, loadCliConfig, loadLiveKitConfig } from "./config";
import { connectDatabase } from "./db/client";
import type { Database } from "./db/database";
import { apiKeyScopes, orgs } from "./db/schema";
import { liveKitRoomEnder, type RoomEnder } from "./livekit";
import {
  ACCOUNT_SLUG,
  accountSummary,
  createAccount,
  findAccount,
  listAccounts,
  liveCallRooms,
  setAccountStatus,
  updateAccountLimits,
  type AccountLimits,
} from "./modules/accounts/accounts";
import { recordAdjustment, recordPayment } from "./modules/billing/payments";
import { addRateCard, listRateCards, SEED_RATE_CARD } from "./modules/billing/rate-cards";
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  setApiKeyConcurrency,
  type ApiKeyScope,
} from "./modules/keys/api-keys";
import { addPoolNumber, E164, listNumbers } from "./modules/numbers/pool";
import { SecretBox } from "./modules/secrets/secret-box";
import type { WebhookEvent } from "./modules/webhooks/enqueue";
import {
  addWebhookEndpoint,
  listWebhookEndpoints,
  setWebhookEndpointEnabled,
  WEBHOOK_EVENTS,
} from "./modules/webhooks/endpoints";
import { isUuid } from "./modules/ids";
import { checkedAddress } from "./modules/webhooks/safe-fetch";
import { errorMessage } from "./error-message";

export class CliError extends Error {}

export type CliDependencies = {
  db: Database;
  secretBox: SecretBox;
  /** Built only when a command needs LiveKit. */
  roomEnder: () => RoomEnder;
  out: (line: string) => void;
  operator: string;
  now?: () => Date;
  /** Default: the SSRF guard's address check (resolves DNS). */
  checkWebhookUrl?: (url: string) => Promise<void>;
};

const USAGE = `usage: bun src/cli.ts <group> <command> [options]

account create <slug> --name <name> [--credit-cap <₹>] [--daily-cap <₹>] [--balance-url <url> --balance-secret <secret>]
account limits <slug> [--credit-cap <₹|none>] [--daily-cap <₹|none>] [--balance-url <url> --balance-secret <secret> | --no-balance-url]
account show <slug>
account list
account suspend <slug> [--end-live-calls]
account resume <slug>
account payment --account <slug> --amount <₹> --ref <payment ref>
account adjust --account <slug> --amount=<±₹> --ref <ref> --reason <text>   (negative: --amount=-500 debits)
key create --account <slug> --name <name> [--max-concurrent-calls <n>] [--scopes calls:read,calls:write] [--expires <YYYY-MM-DD>]
key list --account <slug>
key revoke <prefix>
key concurrency <prefix> <n>
rate-card seed [--from <ISO time>]
rate-card add --name <name> --file <rates.json> [--account <slug>] [--from <ISO time>]
rate-card list [--account <slug>]
number add <+E164>...
number list
webhook add --account <slug> --url <https url> [--events call.ended,usage.recorded,account.credit_low] [--org <external id>] [--description <text>]
webhook list --account <slug>
webhook disable|enable --account <slug> <endpoint id>`;

const MONEY = /^\d+(\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d+(\.\d{1,2})?$/;

function money(value: string | undefined, flag: string, pattern = MONEY): string {
  if (value === undefined || !pattern.test(value)) {
    throw new CliError(`${flag} must be rupees, e.g. 5000 or 5000.50`);
  }
  return value;
}

function optionalLimit(value: string | undefined, flag: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  return money(value, flag);
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(`${name} must be a whole number of 1 or more`);
  }
  return parsed;
}

function time(value: string | undefined, flag: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError(`${flag} must be a date or time, e.g. 2026-11-01T00:00:00+05:30`);
  }
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new CliError(`${flag} is required`);
  return value;
}

function cellText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value === null) return "-";
  return String(value);
}

/** One record as aligned `key  value` lines. */
function show(out: CliDependencies["out"], record: Record<string, unknown>) {
  const width = Math.max(...Object.keys(record).map((key) => key.length));
  for (const [key, value] of Object.entries(record)) {
    out(`${key.padEnd(width)}  ${cellText(value)}`);
  }
}

/** Rows as an aligned table under a header line. */
function table(out: CliDependencies["out"], rows: Record<string, unknown>[]) {
  if (rows.length === 0) return out("(none)");

  const keys = Object.keys(rows[0]!);
  const widths = keys.map((key) =>
    Math.max(key.length, ...rows.map((row) => cellText(row[key]).length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  out(line(keys));
  for (const row of rows) out(line(keys.map((key) => cellText(row[key]))));
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Generic, so each command's `values` are typed from its own options. */
function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(errorMessage(error));
  }
}

function parseList(text: string): string[] {
  return text.split(",").map((item) => item.trim());
}

function refuseUnknown(what: string, given: string[], valid: readonly string[]) {
  const unknown = given.filter((item) => !valid.includes(item));
  if (unknown.length > 0) {
    throw new CliError(`unknown ${what}(s) ${unknown.join(", ")}; valid: ${valid.join(", ")}`);
  }
}

async function accountBySlug(db: Database, slug: string | undefined) {
  const account = await findAccount(db, required(slug, "account slug"));
  if (!account) throw new CliError(`no account "${slug}"`);
  return account;
}

function balanceCheckLimit(values: {
  "balance-url"?: string;
  "balance-secret"?: string;
  "no-balance-url"?: boolean;
}): AccountLimits["balanceCheck"] {
  if (values["no-balance-url"]) return null;
  const url = values["balance-url"];
  const bearerSecret = values["balance-secret"];
  if (url === undefined && bearerSecret === undefined) return undefined;
  if (!url || !bearerSecret) throw new CliError("--balance-url and --balance-secret go together");
  try {
    if (new URL(url).protocol !== "https:") throw new Error();
  } catch {
    throw new CliError("--balance-url must be an https URL");
  }
  return { url, bearerSecret };
}

const limitOptions = {
  "credit-cap": { type: "string" },
  "daily-cap": { type: "string" },
  "balance-url": { type: "string" },
  "balance-secret": { type: "string" },
  "no-balance-url": { type: "boolean" },
} satisfies Options;

/** The account named by an optional flag, or null when the flag was not given. */
async function optionalAccount(db: Database, slug: string | undefined) {
  return slug === undefined ? null : accountBySlug(db, slug);
}

async function accountCommand(deps: CliDependencies, command: string | undefined, args: string[]) {
  const { db, secretBox, out } = deps;
  switch (command) {
    case "create": {
      const { values, positionals } = parse(args, { name: { type: "string" }, ...limitOptions });
      const slug = required(positionals[0], "account slug");
      if (!ACCOUNT_SLUG.test(slug)) {
        throw new CliError("slug: lowercase letters, digits and dashes, 2-40 characters");
      }
      if (await findAccount(db, slug)) throw new CliError(`account "${slug}" already exists`);
      const account = await createAccount(db, secretBox, {
        slug,
        name: required(values.name, "--name"),
        creditCapInr: optionalLimit(values["credit-cap"], "--credit-cap") ?? null,
        dailyCapInr: optionalLimit(values["daily-cap"], "--daily-cap") ?? null,
        balanceCheck: balanceCheckLimit(values) ?? null,
      });
      out(`created account ${account.slug}`);
      return show(out, await accountSummary(db, account));
    }
    case "limits": {
      const { values, positionals } = parse(args, limitOptions);
      const account = await accountBySlug(db, positionals[0]);
      const updated = await updateAccountLimits(db, secretBox, account.id, {
        creditCapInr: optionalLimit(values["credit-cap"], "--credit-cap"),
        dailyCapInr: optionalLimit(values["daily-cap"], "--daily-cap"),
        balanceCheck: balanceCheckLimit(values),
      });
      return show(out, await accountSummary(db, updated));
    }
    case "show": {
      const { positionals } = parse(args, {});
      return show(out, await accountSummary(db, await accountBySlug(db, positionals[0])));
    }
    case "list":
      return table(out, await listAccounts(db));
    case "suspend": {
      const { values, positionals } = parse(args, { "end-live-calls": { type: "boolean" } });
      const account = await accountBySlug(db, positionals[0]);
      await setAccountStatus(db, account.id, "suspended");
      out(
        `suspended ${account.slug}: every key is refused, inbound calls go unanswered, no new call starts`,
      );
      const rooms = await liveCallRooms(db, account.id);
      if (!values["end-live-calls"]) {
        if (rooms.length > 0) {
          out(`${rooms.length} live call(s) continue; add --end-live-calls to end them`);
        }
        return;
      }
      const endRoom = deps.roomEnder();
      const results = await Promise.allSettled(rooms.map((room) => endRoom(room)));
      const failed = results.filter((result) => result.status === "rejected").length;
      out(`ended ${rooms.length - failed} of ${rooms.length} live call(s)`);
      if (failed > 0) {
        throw new CliError(`${failed} live call(s) could not be ended; run the command again`);
      }
      return;
    }
    case "resume": {
      const { positionals } = parse(args, {});
      const account = await accountBySlug(db, positionals[0]);
      await setAccountStatus(db, account.id, "active");
      return out(`resumed ${account.slug}`);
    }
    case "payment": {
      const { values } = parse(args, {
        account: { type: "string" },
        amount: { type: "string" },
        ref: { type: "string" },
      });
      const account = await accountBySlug(db, values.account);
      const amountInr = money(values.amount, "--amount");
      if (Number(amountInr) <= 0) throw new CliError("--amount must be more than 0");
      const reference = required(values.ref, "--ref");
      const { recorded } = await recordPayment(db, {
        accountId: account.id,
        amountInr,
        reference,
        createdBy: deps.operator,
      });
      out(
        recorded
          ? `recorded ₹${amountInr} from ${account.slug} (ref ${reference})`
          : `payment ${reference} was already recorded; nothing changed`,
      );
      return show(out, await accountSummary(db, account));
    }
    case "adjust": {
      const { values } = parse(args, {
        account: { type: "string" },
        amount: { type: "string" },
        ref: { type: "string" },
        reason: { type: "string" },
      });
      const account = await accountBySlug(db, values.account);
      const amountInr = money(values.amount, "--amount", SIGNED_MONEY);
      if (Number(amountInr) === 0) throw new CliError("--amount must not be 0");
      const reference = required(values.ref, "--ref");
      const { recorded } = await recordAdjustment(db, {
        accountId: account.id,
        amountInr,
        reference,
        reason: required(values.reason, "--reason"),
        createdBy: deps.operator,
      });
      out(
        recorded
          ? `adjusted ${account.slug} by ₹${amountInr} (ref ${reference})`
          : `adjustment ${reference} was already recorded; nothing changed`,
      );
      return show(out, await accountSummary(db, account));
    }
    default:
      throw new CliError(`unknown command: account ${command ?? ""}\n\n${USAGE}`);
  }
}

async function keyCommand(deps: CliDependencies, command: string | undefined, args: string[]) {
  const { db, out } = deps;
  switch (command) {
    case "create": {
      const { values } = parse(args, {
        account: { type: "string" },
        name: { type: "string" },
        "max-concurrent-calls": { type: "string", default: "1" },
        scopes: { type: "string", default: apiKeyScopes.join(",") },
        expires: { type: "string" },
      });
      const account = await accountBySlug(db, values.account);
      const scopes = parseList(values.scopes);
      refuseUnknown("scope", scopes, apiKeyScopes);
      const expiresAt =
        values.expires === undefined ? null : time(values.expires, "--expires", new Date());
      const { key, apiKey } = await issueApiKey(db, {
        accountId: account.id,
        name: required(values.name, "--name"),
        maxConcurrentCalls: positiveInteger(
          values["max-concurrent-calls"],
          "--max-concurrent-calls",
        ),
        scopes: scopes as ApiKeyScope[],
        expiresAt,
      });
      out(`key for ${account.slug} (${apiKey.name}), shown once; store it now:`);
      out("");
      out(`  ${key}`);
      out("");
      return show(out, {
        prefix: apiKey.prefix,
        scopes: apiKey.scopes.join(","),
        maxConcurrentCalls: apiKey.maxConcurrentCalls,
        expiresAt: apiKey.expiresAt,
      });
    }
    case "list": {
      const { values } = parse(args, { account: { type: "string" } });
      const account = await accountBySlug(db, values.account);
      const keys = await listApiKeys(db, account.id);
      return table(
        out,
        keys.map((key) => ({ ...key, scopes: key.scopes.join(",") })),
      );
    }
    case "revoke": {
      const { positionals } = parse(args, {});
      const prefix = required(positionals[0], "key prefix");
      if (!(await revokeApiKey(db, prefix, deps.now?.()))) {
        throw new CliError(`no live key with prefix ${prefix}`);
      }
      return out(`revoked ${prefix}: requests with it are refused from now on`);
    }
    case "concurrency": {
      const { positionals } = parse(args, {});
      const prefix = required(positionals[0], "key prefix");
      const limit = positiveInteger(positionals[1], "concurrency");
      if (!(await setApiKeyConcurrency(db, prefix, limit))) {
        throw new CliError(`no key with prefix ${prefix}`);
      }
      return out(`${prefix} may now have ${limit} live call(s) at once`);
    }
    default:
      throw new CliError(`unknown command: key ${command ?? ""}\n\n${USAGE}`);
  }
}

async function rateCardCommand(deps: CliDependencies, command: string | undefined, args: string[]) {
  const { db, out } = deps;
  const now = deps.now?.() ?? new Date();
  switch (command) {
    case "seed": {
      const { values } = parse(args, { from: { type: "string" } });
      const card = await addRateCard(db, {
        accountId: null,
        name: "seed",
        rates: SEED_RATE_CARD,
        effectiveFrom: time(values.from, "--from", now),
      });
      return out(`global card "${card.name}" in effect from ${card.effectiveFrom.toISOString()}`);
    }
    case "add": {
      const { values } = parse(args, {
        name: { type: "string" },
        file: { type: "string" },
        account: { type: "string" },
        from: { type: "string" },
      });
      const account = await optionalAccount(db, values.account);
      const file = required(values.file, "--file");
      const name = required(values.name, "--name");
      const effectiveFrom = time(values.from, "--from", now);

      let rates: unknown;
      try {
        rates = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new CliError(`could not read ${file}: ${errorMessage(error)}`);
      }

      let card;
      try {
        card = await addRateCard(db, {
          accountId: account?.id ?? null,
          name,
          rates,
          effectiveFrom,
        });
      } catch (error) {
        throw new CliError(errorMessage(error));
      }
      const owner = account ? `${account.slug}'s` : "global";
      return out(`${owner} card "${card.name}" in effect from ${card.effectiveFrom.toISOString()}`);
    }
    case "list": {
      const { values } = parse(args, { account: { type: "string" } });
      const account = await optionalAccount(db, values.account);
      const cards = await listRateCards(db, account?.id ?? null);
      return table(
        out,
        cards.map(({ rates, ...card }) => ({
          ...card,
          sell: JSON.stringify((rates as { sell: unknown }).sell),
        })),
      );
    }
    default:
      throw new CliError(`unknown command: rate-card ${command ?? ""}\n\n${USAGE}`);
  }
}

async function numberCommand(deps: CliDependencies, command: string | undefined, args: string[]) {
  const { db, out } = deps;
  switch (command) {
    case "add": {
      const { positionals } = parse(args, {});
      if (positionals.length === 0) {
        throw new CliError("give at least one number, e.g. +918045001234");
      }
      const invalid = positionals.filter((number) => !E164.test(number));
      if (invalid.length > 0) throw new CliError(`not E.164: ${invalid.join(", ")}`);
      for (const number of positionals) {
        const added = await addPoolNumber(db, number);
        out(added ? `added ${number} to the pool` : `${number} is already on file`);
      }
      return;
    }
    case "list":
      return table(out, await listNumbers(db));
    default:
      throw new CliError(`unknown command: number ${command ?? ""}\n\n${USAGE}`);
  }
}

/** The SSRF guard's check, run when an endpoint is added so a bad URL is refused at once. */
async function checkPublicHttpsUrl(url: string): Promise<void> {
  await checkedAddress(new URL(url), {});
}

async function webhookCommand(deps: CliDependencies, command: string | undefined, args: string[]) {
  const { db, out } = deps;
  switch (command) {
    case "add": {
      const { values } = parse(args, {
        account: { type: "string" },
        url: { type: "string" },
        events: { type: "string", default: WEBHOOK_EVENTS.join(",") },
        org: { type: "string" },
        description: { type: "string" },
      });
      const account = await accountBySlug(db, values.account);
      const url = required(values.url, "--url");
      const checkUrl = deps.checkWebhookUrl ?? checkPublicHttpsUrl;
      try {
        await checkUrl(url);
      } catch (error) {
        throw new CliError(`--url refused: ${errorMessage(error)}`);
      }
      const events = parseList(values.events);
      refuseUnknown("event", events, WEBHOOK_EVENTS);
      let orgId: string | null = null;
      if (values.org !== undefined) {
        const [org] = await db
          .select({ id: orgs.id })
          .from(orgs)
          .where(and(eq(orgs.accountId, account.id), eq(orgs.externalId, values.org)));
        if (!org) throw new CliError(`${account.slug} has no org "${values.org}"`);
        orgId = org.id;
      }
      const { endpoint, secret } = await addWebhookEndpoint(db, deps.secretBox, {
        accountId: account.id,
        orgId,
        url,
        events: events as WebhookEvent[],
        description: values.description ?? null,
      });
      out(`endpoint ${endpoint.id} for ${account.slug}; signing secret, shown once:`);
      out("");
      out(`  ${secret}`);
      out("");
      const signedText = '"<X-Automitra-Timestamp>.<body>"';
      return out(`verify: X-Automitra-Signature = sha256=<hex HMAC-SHA256(secret, ${signedText})>`);
    }
    case "list": {
      const { values } = parse(args, { account: { type: "string" } });
      const account = await accountBySlug(db, values.account);
      const endpoints = await listWebhookEndpoints(db, account.id);
      return table(
        out,
        endpoints.map((endpoint) => ({ ...endpoint, events: endpoint.events.join(",") })),
      );
    }
    case "disable":
    case "enable": {
      const { values, positionals } = parse(args, { account: { type: "string" } });
      const account = await accountBySlug(db, values.account);
      const id = required(positionals[0], "endpoint id");
      const enabled = command === "enable";
      const changed = isUuid(id) && (await setWebhookEndpointEnabled(db, account.id, id, enabled));
      if (!changed) throw new CliError(`${account.slug} has no endpoint ${id}`);
      return out(
        enabled
          ? `enabled ${id}; its queued events will be delivered`
          : `disabled ${id}; its events wait in the queue`,
      );
    }
    default:
      throw new CliError(`unknown command: webhook ${command ?? ""}\n\n${USAGE}`);
  }
}

/** Returns the exit code. Every failure the operator can fix is a `CliError` with a readable message. */
export async function runCli(argv: string[], deps: CliDependencies): Promise<number> {
  const [group, command, ...args] = argv;
  try {
    switch (group) {
      case "account":
        await accountCommand(deps, command, args);
        break;
      case "key":
        await keyCommand(deps, command, args);
        break;
      case "rate-card":
        await rateCardCommand(deps, command, args);
        break;
      case "number":
        await numberCommand(deps, command, args);
        break;
      case "webhook":
        await webhookCommand(deps, command, args);
        break;
      case undefined:
      case "help":
      case "--help":
        deps.out(USAGE);
        break;
      default:
        throw new CliError(`unknown group: ${group}\n\n${USAGE}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      deps.out(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  let config;
  try {
    config = loadCliConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }
  const database = connectDatabase(config.DATABASE_URL);
  const code = await runCli(process.argv.slice(2), {
    db: database.db,
    secretBox: new SecretBox(config.SECRETS_KEY),
    roomEnder: () => {
      try {
        return liveKitRoomEnder(loadLiveKitConfig());
      } catch (error) {
        throw error instanceof ConfigError
          ? new CliError(`--end-live-calls needs LiveKit: ${error.message}`)
          : error;
      }
    },
    out: (line) => console.log(line),
    operator: `cli:${process.env.OPERATOR ?? userInfo().username}`,
  });
  await database.close();
  process.exit(code);
}
