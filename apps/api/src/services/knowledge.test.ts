/**
 * Knowledge bases: splitting documents, and finding the right passage.
 *
 * The search tests run against Postgres, because the behaviour that matters
 * -- how `to_tsvector('simple', …)` splits Devanagari, how OR-ed terms rank
 * -- is the database's, not this code's.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { closeRedis } from "../cache";
import { createClient } from "../db/client";
import { agentKnowledgeBases, agents, agentVersions, knowledgeBases, orgs } from "../db/schema";
import { addDocument, chunkText, htmlToText, KnowledgeError, queryTerms, searchKnowledge } from "./knowledge";

describe("chunking", () => {
  test("keeps paragraphs together up to the target size", () => {
    const chunks = chunkText("Service prices.\n\nOil change Rs 1,200.\n\nBrake pads Rs 3,400.");
    expect(chunks).toEqual(["Service prices.\n\nOil change Rs 1,200.\n\nBrake pads Rs 3,400."]);
  });

  test("starts a new chunk rather than overflow one", () => {
    const para = "x".repeat(600);
    expect(chunkText(`${para}\n\n${para}\n\n${para}`)).toHaveLength(3);
  });

  test("splits an overlong paragraph at sentences, and cuts an overlong sentence", () => {
    const sentence = `${"word ".repeat(100).trim()}.`;
    const chunks = chunkText(Array(6).fill(sentence).join(" "));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1400);
    expect(chunkText("y".repeat(5000)).every((c) => c.length <= 1400)).toBe(true);
  });
});

describe("web pages", () => {
  test("keeps the words and drops the machinery", () => {
    const text = htmlToText(
      "<html><head><style>p{}</style><script>track()</script></head><body><nav>Home</nav>" +
        "<h1>Prices</h1><p>Thar &amp; XUV700</p><p>Rs&nbsp;15&#44;000 &#x2014; <b>on road</b></p></body></html>",
    );
    expect(text).toBe("Prices\n\nThar & XUV700\n\nRs 15,000 — on road");
  });
});

describe("queries", () => {
  test("keeps meaningful words, in any script, and nothing else", () => {
    expect(queryTerms("What is the price of the Thar?")).toBe("price | thar");
    expect(queryTerms("थार की कीमत क्या है")).toBe("थार | कीमत");
    expect(queryTerms("service kab hai")).toBe("service");
  });

  test("tsquery syntax a caller says cannot reach the query", () => {
    expect(queryTerms("price & !thar | (xuv) :*")).toBe("price | thar | xuv");
    expect(queryTerms("??? ...")).toBeNull();
  });
});

describe("searching", () => {
  const { sql, db } = createClient({ max: 2 });
  const fx = { orgA: "", orgB: "", versionA: "", kbA: "", kbUnattached: "" };

  beforeAll(async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const orgA = (await db.insert(orgs).values({ name: "KA", slug: `ka-${suffix}` }).returning())[0]!;
    const orgB = (await db.insert(orgs).values({ name: "KB", slug: `kb-${suffix}` }).returning())[0]!;
    const agent = (await db.insert(agents).values({ orgId: orgA.id, name: "A", slug: `a-${suffix}` }).returning())[0]!;
    const version = (
      await db
        .insert(agentVersions)
        .values({ agentId: agent.id, orgId: orgA.id, version: 1, instructions: "p", greeting: "g", config: {} })
        .returning()
    )[0]!;
    const kb = (await db.insert(knowledgeBases).values({ orgId: orgA.id, name: "Dealership" }).returning())[0]!;
    const other = (await db.insert(knowledgeBases).values({ orgId: orgA.id, name: "Unattached" }).returning())[0]!;
    await db.insert(agentKnowledgeBases).values({ agentVersionId: version.id, knowledgeBaseId: kb.id });

    await addDocument(db, orgA.id, kb.id, {
      title: "Prices",
      text:
        "The Thar starts at Rs 11.35 lakh ex-showroom.\n\n" +
        "Service centre hours: Monday to Saturday, 9am to 7pm. Closed on Sundays.\n\n" +
        "थार की कीमत 11.35 लाख रुपये से शुरू होती है।",
    });
    await addDocument(db, orgA.id, other.id, { title: "Secret", text: "The Thar discount code is HIDDEN." });

    Object.assign(fx, { orgA: orgA.id, orgB: orgB.id, versionA: version.id, kbA: kb.id, kbUnattached: other.id });
  });

  afterAll(async () => {
    for (const id of [fx.orgA, fx.orgB]) await db.delete(orgs).where(eq(orgs.id, id)).catch(() => {});
    await Promise.allSettled([sql.end(), closeRedis()]);
  });

  test("a question finds the passage that answers it", async () => {
    const passages = await searchKnowledge(db, fx.orgA, fx.versionA, "What are your service hours on Saturday?");
    expect(passages[0]?.content).toContain("Monday to Saturday");
  });

  test("a question in Hindi finds the Hindi passage", async () => {
    const passages = await searchKnowledge(db, fx.orgA, fx.versionA, "थार की कीमत क्या है");
    expect(passages.some((p) => p.content.includes("थार की कीमत"))).toBe(true);
  });

  test("only the knowledge bases the version searches are searched", async () => {
    const passages = await searchKnowledge(db, fx.orgA, fx.versionA, "discount code");
    expect(passages.map((p) => p.content).join(" ")).not.toContain("HIDDEN");
  });

  test("another organisation cannot search this version's documents", async () => {
    expect(await searchKnowledge(db, fx.orgB, fx.versionA, "Thar price")).toEqual([]);
  });

  test("an empty or unknown document is refused", async () => {
    await expect(addDocument(db, fx.orgA, fx.kbA, { text: "   " })).rejects.toBeInstanceOf(KnowledgeError);
    await expect(addDocument(db, fx.orgB, fx.kbA, { text: "x" })).rejects.toBeInstanceOf(KnowledgeError);
  });

  test("a document URL goes through the SSRF guard", async () => {
    await expect(addDocument(db, fx.orgA, fx.kbA, { url: "https://169.254.169.254/latest" })).rejects.toBeInstanceOf(
      KnowledgeError,
    );
  });
});
