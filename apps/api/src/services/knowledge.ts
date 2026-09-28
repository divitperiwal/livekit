/**
 * Knowledge bases: adding documents, and finding the passages that answer a
 * caller's question.
 *
 * See the schema file for why this is keyword search rather than embeddings.
 * The query side matters as much as the index: a caller's question is a
 * sentence, and requiring every word of it to appear in one passage finds
 * nothing. So the words are OR-ed together and the passages ranked by how
 * many -- and how close together -- they contain.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { agentKnowledgeBases, knowledgeBases, knowledgeChunks, knowledgeDocuments } from "../db/schema";
import { safeRequest } from "./safe-fetch";

export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 413 | 422 | 502,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export const MAX_DOCUMENT_CHARS = 500_000;
const TARGET_CHUNK = 900;
const MAX_CHUNK = 1400;
const SEARCH_RESULTS = 4;

/** Words too common to say anything about which passage is meant. */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from how i in is it me my of on or our " +
    "please the their this to was what when where which who why will with you your " +
    "hai hain ka ki ke ko kya kab kahan kaise mein main se aap hum tum bhi toh na nahi " +
    "है हैं का की के को क्या कब कहाँ कैसे में से आप हम तुम भी तो ना नहीं"
  ).split(" "),
);

/**
 * Splits text into passages of a few paragraphs.
 *
 * Paragraph boundaries are kept where possible, because a passage that
 * starts halfway through a price list is one the model will misread. A
 * paragraph too long on its own is split at sentences, and a sentence too
 * long on its own is cut.
 */
export function chunkText(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK) {
      pieces.push(paragraph);
      continue;
    }
    let current = "";
    for (const sentence of paragraph.split(/(?<=[.!?।])\s+/)) {
      for (let i = 0; i < sentence.length; i += MAX_CHUNK) {
        const part = sentence.slice(i, i + MAX_CHUNK);
        if (current && current.length + part.length + 1 > MAX_CHUNK) {
          pieces.push(current);
          current = "";
        }
        current = current ? `${current} ${part}` : part;
      }
    }
    if (current) pieces.push(current);
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > TARGET_CHUNK) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** The readable text of a web page: no scripts, styles, navigation or tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (match, name: string) => {
      if (ENTITIES[name]) return ENTITIES[name];
      if (name.startsWith("#")) {
        const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A caller's question as a tsquery: its meaningful words, any of which may
 * match. Words are letters and digits in any script, so Devanagari survives,
 * and nothing the caller said can inject tsquery syntax.
 */
export function queryTerms(query: string): string | null {
  // \p{M} matters: Devanagari vowel signs are combining marks, and without
  // them "थार" would be split into fragments that match nothing.
  const words = (query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 1 && !STOPWORDS.has(w),
  );
  const unique = [...new Set(words)].slice(0, 12);
  return unique.length ? unique.join(" | ") : null;
}

export async function getKnowledgeBase(db: Database, orgId: string, id: string) {
  const kb = (
    await db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.orgId, orgId)))
      .limit(1)
  )[0];
  if (!kb) throw new KnowledgeError("no such knowledge base", 404);
  return kb;
}

/**
 * Adds a document, from text or from a URL fetched once, now.
 *
 * A URL is not re-fetched later. A page that changes underneath an agent
 * would change what it tells callers with nobody having looked; re-adding the
 * page is a deliberate act.
 */
export async function addDocument(
  db: Database,
  orgId: string,
  knowledgeBaseId: string,
  input: { title?: unknown; text?: unknown; url?: unknown },
) {
  await getKnowledgeBase(db, orgId, knowledgeBaseId);

  let text: string;
  let sourceUrl: string | null = null;
  if (typeof input.url === "string" && input.url.trim()) {
    sourceUrl = input.url.trim();
    let response;
    try {
      response = await safeRequest(sourceUrl, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024 });
    } catch (error) {
      throw new KnowledgeError(`could not fetch that page: ${(error as Error).message}`, 422);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new KnowledgeError(`the page returned ${response.status}`, 502);
    }
    const type = String(response.headers["content-type"] ?? "");
    text = type.includes("html") ? htmlToText(response.body) : response.body;
  } else if (typeof input.text === "string") {
    text = input.text;
  } else {
    throw new KnowledgeError("send the document's text, or a url to fetch it from", 422);
  }

  text = text.trim();
  if (!text) throw new KnowledgeError("the document is empty", 422);
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new KnowledgeError(`a document may be at most ${MAX_DOCUMENT_CHARS} characters; split it`, 413);
  }

  const chunks = chunkText(text);
  const title =
    (typeof input.title === "string" && input.title.trim()) || sourceUrl || text.slice(0, 60).replace(/\s+/g, " ");

  return db.transaction(async (tx) => {
    const document = (
      await tx
        .insert(knowledgeDocuments)
        .values({
          orgId,
          knowledgeBaseId,
          title: title.slice(0, 200),
          sourceType: sourceUrl ? "url" : "text",
          sourceUrl,
          chars: text.length,
          chunkCount: chunks.length,
        })
        .returning()
    )[0]!;
    for (let i = 0; i < chunks.length; i += 500) {
      await tx.insert(knowledgeChunks).values(
        chunks.slice(i, i + 500).map((content, offset) => ({
          orgId,
          knowledgeBaseId,
          documentId: document.id,
          position: i + offset,
          content,
        })),
      );
    }
    await tx.update(knowledgeBases).set({ updatedAt: new Date() }).where(eq(knowledgeBases.id, knowledgeBaseId));
    return document;
  });
}

export interface Passage {
  content: string;
  document: string;
  rank: number;
}

/**
 * The passages that best answer `query`, from the knowledge bases attached
 * to an agent version.
 *
 * Scoped by organisation as well as by version, so a version id from one
 * tenant can never read another's documents.
 */
export async function searchKnowledge(
  db: Database,
  orgId: string,
  agentVersionId: string,
  query: string,
  limit = SEARCH_RESULTS,
): Promise<Passage[]> {
  const terms = queryTerms(query);
  if (!terms) return [];

  const rows = await db.execute<{ content: string; document: string; rank: number }>(sql`
    select c.content, d.title as document, ts_rank_cd(c.tsv, q) as rank
    from ${knowledgeChunks} c
    join ${agentKnowledgeBases} akb
      on akb.knowledge_base_id = c.knowledge_base_id and akb.agent_version_id = ${agentVersionId}
    join ${knowledgeDocuments} d on d.id = c.document_id,
    to_tsquery('simple', ${terms}) q
    where c.org_id = ${orgId} and c.tsv @@ q
    order by rank desc, c.position
    limit ${limit}
  `);
  return rows.map((r) => ({ content: r.content, document: r.document, rank: Number(r.rank) }));
}

/** How many knowledge bases a version searches, for the worker to know whether to offer the tool. */
export async function knowledgeBaseCount(db: Database, agentVersionId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentKnowledgeBases)
    .where(eq(agentKnowledgeBases.agentVersionId, agentVersionId));
  return rows[0]?.n ?? 0;
}
