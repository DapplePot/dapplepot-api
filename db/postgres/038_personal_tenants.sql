-- Personal tenants for individual-developer self-signup.
-- Existing tenants default to kind='organization' so no backfill is needed.
--
-- NOTE: this migration originally created an email_verifications table for a
-- create-user-then-verify flow. That table is dropped in 039_pending_signups.sql
-- and replaced with pending_signups for a verify-then-create flow.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS kind          TEXT NOT NULL DEFAULT 'organization'
                                          CHECK (kind IN ('personal', 'organization')),
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_personal_owner
    ON tenants (owner_user_id) WHERE kind = 'personal';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS signup_source     TEXT
        CHECK (signup_source IN ('self_signup', 'invite', 'superadmin_onboard'));

CREATE TABLE IF NOT EXISTS email_verifications (
    verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_user
    ON email_verifications (user_id);
