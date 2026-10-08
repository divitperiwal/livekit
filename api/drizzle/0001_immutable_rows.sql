-- Guarantee 10: the ledger is append-only.
CREATE FUNCTION account_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account_ledger is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_ledger_append_only
BEFORE UPDATE OR DELETE ON account_ledger
FOR EACH ROW EXECUTE FUNCTION account_ledger_append_only();
--> statement-breakpoint
-- Guarantee 16: agent versions are never updated in place. Publishing may stamp
-- published_at / published_by once; nothing else may change.
CREATE FUNCTION agent_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NULL
     AND NEW.published_at IS NOT NULL
     AND (to_jsonb(NEW) - 'published_at' - 'published_by') = (to_jsonb(OLD) - 'published_at' - 'published_by')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_versions rows are immutable; write a new version' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_versions_immutable
BEFORE UPDATE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION agent_versions_immutable();
