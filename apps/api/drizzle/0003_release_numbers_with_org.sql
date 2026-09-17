-- Return a phone number to the pool when its organisation goes away.
--
-- The foreign key already nulls `org_id` rather than deleting the row, which
-- is right: the number is platform inventory that outlives any one customer,
-- and deleting it would lose the mapping history that call records point at.
--
-- But nulling the owner on its own leaves the row still marked `assigned` and
-- still pointing at a deleted agent -- a number that looks taken, belongs to
-- nobody, and can never be handed to the next customer because `e164` is
-- globally unique. The number is then effectively destroyed while appearing to
-- exist.
--
-- Written as a trigger rather than as application code so it holds however the
-- organisation is removed: through the API, through a migration, or by hand in
-- psql during an incident.

CREATE OR REPLACE FUNCTION release_phone_numbers_of_deleted_org()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE phone_numbers
  SET status = 'available',
      agent_id = NULL,
      lk_dispatch_rule_id = NULL,
      released_at = now(),
      updated_at = now()
  WHERE org_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- BEFORE, so it runs while the rows still carry the org id. An AFTER trigger
-- would find org_id already nulled by the foreign key and match nothing.
CREATE TRIGGER release_phone_numbers_before_org_delete
  BEFORE DELETE ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION release_phone_numbers_of_deleted_org();
