-- OAuth identity columns for "Sign in with Google" (and future providers).
--
-- An OAuth-only user has password_hash IS NULL — they prove identity by
-- re-completing the provider flow. A user can hold both: local password +
-- linked OAuth identity (set when an existing email-verified account links
-- a new provider).
--
-- oauth_provider     — 'google' for now; extensible.
-- oauth_provider_sub — provider's stable subject identifier (Google's `sub`
--                      claim). Never derived from email, which can change.
-- We key on (provider, sub) so the same provider can never produce two
-- identical identities. A user can drop and re-link (rare) — both columns
-- are nullable.
--
-- Idempotent — re-running is a no-op.

ALTER TABLE users
    ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS oauth_provider     TEXT,
    ADD COLUMN IF NOT EXISTS oauth_provider_sub TEXT;

-- Both columns must be set together (or both NULL). Belt-and-braces guard;
-- the app always sets them in pairs but a misuse via psql is worth catching.
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_oauth_pair_chk;
ALTER TABLE users
    ADD CONSTRAINT users_oauth_pair_chk
    CHECK ((oauth_provider IS NULL) = (oauth_provider_sub IS NULL));

-- Same provider identity → exactly one local user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_oauth_identity
    ON users (oauth_provider, oauth_provider_sub)
    WHERE oauth_provider IS NOT NULL;
