-- Extensions the schema depends on.
--
-- Hand-written and ordered first, because drizzle-kit emits a citext column
-- without the extension that provides the type: a generated migration alone
-- fails on a fresh database.
--
-- citext gives case-insensitive text, so a unique index on users.email
-- actually prevents Alice@ and alice@ existing as two accounts, rather than
-- relying on every call site remembering to lower() first.
CREATE EXTENSION IF NOT EXISTS citext;
