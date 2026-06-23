-- Switch individual-developer signup from "create-user-then-verify" to
-- "verify-then-create". The original 038 staged a verification token against
-- an already-created user row; we now stage the full signup (email, name,
-- password_hash) and only create the user/tenant/sdk_key when the token
-- is consumed. See ind_dev.md.

DROP TABLE IF EXISTS email_verifications;

CREATE TABLE IF NOT EXISTS pending_signups (
    signup_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL,
    name          TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    token_hash    TEXT        NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_signups_email_active
    ON pending_signups (LOWER(email)) WHERE used_at IS NULL;
