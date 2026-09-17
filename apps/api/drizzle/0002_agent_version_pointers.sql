-- The two pointers from an agent to its versions.
--
-- Hand-written because agents and agent_versions reference each other: an
-- agent points at its draft and live versions, and every version points back
-- at its agent. One table has to be created before the other, so these two
-- constraints are added once both exist.
--
-- ON DELETE SET NULL rather than CASCADE, deliberately. Deleting a version
-- must not delete the agent -- it should leave the agent pointing at nothing,
-- which is a recoverable state, rather than destroying it.

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_draft_version_id_fk"
  FOREIGN KEY ("draft_version_id") REFERENCES "agent_versions"("id")
  ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_live_version_id_fk"
  FOREIGN KEY ("live_version_id") REFERENCES "agent_versions"("id")
  ON DELETE SET NULL;
