/**
 * The organisation's own settings and integrations: recording, API keys,
 * webhooks, knowledge bases.
 *
 * Mounted beneath the session middleware in `api.ts`. What changes how every
 * call behaves or what leaves the platform -- recording, keys, webhooks --
 * needs an owner or admin; editing knowledge needs only write access, like
 * editing an agent.
 */

import { Hono, type Context } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { apiKeys, knowledgeBases, knowledgeDocuments, orgs, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { createApiKey, keyView, SCOPES } from "../services/api-keys";
import { AuthError, requireAdmin, requireWrite, type Session } from "../services/auth";
import { addDocument, getKnowledgeBase, KnowledgeError } from "../services/knowledge";
import { playbackUrl, recordingStore } from "../services/recordings";
import { encryptSecret, SecretsUnavailable } from "../services/secrets";
import { urlProblem } from "../services/tools";
import { enqueuePing, WEBHOOK_EVENTS } from "../services/webhooks";

type Vars = { session: Session; sessionId: string };
type Ctx = Context<{ Variables: Vars }>;

function failure(c: Ctx, error: unknown) {
  if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
  if (error instanceof KnowledgeError) return c.json({ error: error.message }, error.status);
  if (error instanceof SecretsUnavailable) return c.json({ error: error.message }, 503);
  throw error;
}

/** A signing secret: shown once, then only ever held encrypted. */
function newSigningSecret(): string {
  return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
}

function checkEvents(raw: unknown): string[] | null {
  if (raw === undefined) return [...WEBHOOK_EVENTS];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const events = [...new Set(raw.map(String))];
  return events.every((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e)) ? events : null;
}

export function workspaceRoutes(db: Database) {
  const app = new Hono<{ Variables: Vars }>();

  // --- settings --------------------------------------------------------------

  app.get("/settings", async (c) => {
    const { orgId } = c.get("session");
    const org = (await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1))[0]!;
    return c.json({
      recordCalls: org.recordCalls,
      recordingRetentionDays: org.recordingRetentionDays,
      redactPii: org.redactPii,
      // Whether turning recording on would actually record anything.
      recordingStorageConfigured: recordingStore() !== null,
    });
  });

  app.patch("/settings", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as {
        recordCalls?: unknown;
        recordingRetentionDays?: unknown;
        redactPii?: unknown;
      };
      const set: Partial<typeof orgs.$inferInsert> = { updatedAt: new Date() };
      if (body.recordCalls !== undefined) {
        if (typeof body.recordCalls !== "boolean") return c.json({ error: "recordCalls must be true or false" }, 422);
        set.recordCalls = body.recordCalls;
      }
      if (body.redactPii !== undefined) {
        if (typeof body.redactPii !== "boolean") return c.json({ error: "redactPii must be true or false" }, 422);
        set.redactPii = body.redactPii;
      }
      if (body.recordingRetentionDays !== undefined) {
        const days = body.recordingRetentionDays;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
          return c.json({ error: "recordingRetentionDays must be a whole number of days from 1 to 3650" }, 422);
        }
        set.recordingRetentionDays = days;
      }
      await db.update(orgs).set(set).where(eq(orgs.id, session.orgId));
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** A link to play a recording, valid for minutes. */
  app.get("/calls/:id/recording", async (c) => {
    const url = await playbackUrl(db, c.get("session").orgId, c.req.param("id"));
    if (!url) return c.json({ error: "no recording for this call" }, 404);
    return c.json({ url });
  });

  // --- API keys ----------------------------------------------------------------

  app.get("/api-keys", async (c) => {
    try {
      requireAdmin(c.get("session"));
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.orgId, c.get("session").orgId))
        .orderBy(desc(apiKeys.createdAt));
      return c.json({ keys: rows.map(keyView), scopes: SCOPES });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** Makes a key. The response is the only time the key itself is ever sent. */
  app.post("/api-keys", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as { name?: unknown; scopes?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ error: "name the key after what will use it" }, 422);
      const scopes = body.scopes === undefined ? undefined : Array.isArray(body.scopes) ? body.scopes.map(String) : null;
      if (scopes === null || (scopes && scopes.some((s) => !(SCOPES as readonly string[]).includes(s)))) {
        return c.json({ error: `scopes may only contain: ${SCOPES.join(", ")}` }, 422);
      }
      const { key, row } = await createApiKey(db, session.orgId, session.userId, name, scopes);
      return c.json({ key, apiKey: keyView(row) }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  /** Revokes rather than deletes, so the list still shows what a key was. */
  app.delete("/api-keys/:id", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const revoked = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.orgId, session.orgId)))
        .returning({ id: apiKeys.id });
      if (!revoked[0]) return c.json({ error: "no such key" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  // --- webhooks ----------------------------------------------------------------

  const endpointView = (row: typeof webhookEndpoints.$inferSelect) => {
    const { secretCiphertext, ...rest } = row;
    return rest;
  };

  app.get("/webhooks", async (c) => {
    try {
      requireAdmin(c.get("session"));
      const rows = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.orgId, c.get("session").orgId))
        .orderBy(webhookEndpoints.createdAt);
      return c.json({ endpoints: rows.map(endpointView), events: WEBHOOK_EVENTS });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** Adds an endpoint. The signing secret is in this response and never again. */
  app.post("/webhooks", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as { url?: unknown; description?: unknown; events?: unknown };
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const problem = url ? urlProblem(url) : "is required";
      if (problem) return c.json({ error: `url ${problem}`, fields: { url: problem } }, 422);
      const events = checkEvents(body.events);
      if (!events) return c.json({ error: `events may only contain: ${WEBHOOK_EVENTS.join(", ")}` }, 422);

      const secret = newSigningSecret();
      const row = (
        await db
          .insert(webhookEndpoints)
          .values({
            orgId: session.orgId,
            url,
            description: typeof body.description === "string" ? body.description.trim() || null : null,
            secretCiphertext: await encryptSecret(secret),
            events,
          })
          .returning()
      )[0]!;
      return c.json({ endpoint: endpointView(row), secret }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.patch("/webhooks/:id", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as { enabled?: unknown; events?: unknown };
      const set: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 422);
        set.enabled = body.enabled;
      }
      if (body.events !== undefined) {
        const events = checkEvents(body.events);
        if (!events) return c.json({ error: `events may only contain: ${WEBHOOK_EVENTS.join(", ")}` }, 422);
        set.events = events;
      }
      const updated = await db
        .update(webhookEndpoints)
        .set(set)
        .where(and(eq(webhookEndpoints.id, c.req.param("id")), eq(webhookEndpoints.orgId, session.orgId)))
        .returning();
      if (!updated[0]) return c.json({ error: "no such endpoint" }, 404);
      return c.json({ endpoint: endpointView(updated[0]) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.delete("/webhooks/:id", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const deleted = await db
        .delete(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, c.req.param("id")), eq(webhookEndpoints.orgId, session.orgId)))
        .returning({ id: webhookEndpoints.id });
      if (!deleted[0]) return c.json({ error: "no such endpoint" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** The endpoint's recent deliveries: what was sent, and what came back. */
  app.get("/webhooks/:id/deliveries", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const rows = await db
        .select({
          id: webhookDeliveries.id,
          event: webhookDeliveries.event,
          eventKey: webhookDeliveries.eventKey,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          lastStatusCode: webhookDeliveries.lastStatusCode,
          lastError: webhookDeliveries.lastError,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          deliveredAt: webhookDeliveries.deliveredAt,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.endpointId, c.req.param("id")), eq(webhookDeliveries.orgId, session.orgId)))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(50);
      return c.json({ deliveries: rows });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** Queues a `ping`, for checking an endpoint receives and verifies events. */
  app.post("/webhooks/:id/test", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const owned = await db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, c.req.param("id")), eq(webhookEndpoints.orgId, session.orgId)))
        .limit(1);
      if (!owned[0]) return c.json({ error: "no such endpoint" }, 404);
      return c.json({ eventId: await enqueuePing(db, session.orgId, owned[0].id) }, 202);
    } catch (error) {
      return failure(c, error);
    }
  });

  // --- knowledge ---------------------------------------------------------------

  app.get("/knowledge-bases", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db
      .select({
        id: knowledgeBases.id,
        name: knowledgeBases.name,
        description: knowledgeBases.description,
        updatedAt: knowledgeBases.updatedAt,
        documents: sql<number>`(select count(*)::int from ${knowledgeDocuments} d where d.knowledge_base_id = ${knowledgeBases.id})`,
      })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.orgId, orgId))
      .orderBy(knowledgeBases.name);
    return c.json({ knowledgeBases: rows });
  });

  app.post("/knowledge-bases", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const body = (await c.req.json()) as { name?: unknown; description?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ error: "name is required" }, 422);
      const row = (
        await db
          .insert(knowledgeBases)
          .values({
            orgId: session.orgId,
            name,
            description: typeof body.description === "string" ? body.description.trim() || null : null,
          })
          .returning()
      )[0]!;
      return c.json({ knowledgeBase: row }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/knowledge-bases/:id", async (c) => {
    try {
      const { orgId } = c.get("session");
      const kb = await getKnowledgeBase(db, orgId, c.req.param("id"));
      const documents = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.knowledgeBaseId, kb.id))
        .orderBy(desc(knowledgeDocuments.createdAt));
      return c.json({ knowledgeBase: kb, documents });
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * Deletes a knowledge base. Agent versions that searched it simply stop
   * finding anything in it; nothing else about them changes.
   */
  app.delete("/knowledge-bases/:id", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const kb = await getKnowledgeBase(db, session.orgId, c.req.param("id"));
      await db.delete(knowledgeBases).where(eq(knowledgeBases.id, kb.id));
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** `{ title, text }` or `{ title, url }`. */
  app.post("/knowledge-bases/:id/documents", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const document = await addDocument(db, session.orgId, c.req.param("id"), await c.req.json());
      return c.json({ document }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.delete("/knowledge-bases/:id/documents/:documentId", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const deleted = await db
        .delete(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.id, c.req.param("documentId")),
            eq(knowledgeDocuments.knowledgeBaseId, c.req.param("id")),
            eq(knowledgeDocuments.orgId, session.orgId),
          ),
        )
        .returning({ id: knowledgeDocuments.id });
      if (!deleted[0]) return c.json({ error: "no such document" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
