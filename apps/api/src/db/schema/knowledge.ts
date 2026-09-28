/**
 * Knowledge bases: a business's reference material, for the agent to search.
 *
 * Documents are split into chunks of a few paragraphs, and each chunk carries
 * a full-text index the database maintains itself. Retrieval is keyword
 * search, not embeddings: it needs no second model provider and no vector
 * extension, and on the price lists, policies and FAQs this is used for, the
 * caller's own words are usually the words in the document. The `simple`
 * text configuration is used because it does no language-specific stemming,
 * which is right for Hindi, Hinglish and English mixed in one sentence --
 * an English stemmer would mangle the first two.
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  customType,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { agentVersions } from "./agents";
import { createdAt, id, orgs, updatedAt } from "./identity";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("knowledge_bases_org_idx").on(t.orgId)],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** "text" (pasted or uploaded) or "url" (fetched once, when added). */
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    chars: integer("chars").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("knowledge_documents_kb_idx").on(t.knowledgeBaseId)],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    /** Maintained by the database from `content`; never written directly. */
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
  },
  (t) => [
    index("knowledge_chunks_tsv_idx").using("gin", t.tsv),
    index("knowledge_chunks_kb_idx").on(t.knowledgeBaseId),
  ],
);

/**
 * Which knowledge bases an agent version searches. On the version, like its
 * tools, so a published version's reference material is part of what it is.
 * The documents inside a knowledge base are not frozen: correcting a price
 * list should reach every agent without a republish.
 */
export const agentKnowledgeBases = pgTable(
  "agent_knowledge_bases",
  {
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_knowledge_bases_pkey").on(t.agentVersionId, t.knowledgeBaseId),
    index("agent_knowledge_bases_kb_idx").on(t.knowledgeBaseId),
  ],
);
