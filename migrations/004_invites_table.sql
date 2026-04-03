CREATE TABLE IF NOT EXISTS invites (
    invite_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id),
    email         TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'editor', 'viewer')),
    invited_by    UUID NOT NULL REFERENCES users(user_id),
    token_hash    TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
    expires_at    TIMESTAMPTZ NOT NULL,
    accepted_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_invites_tenant_email_pending
        UNIQUE (tenant_id, email)
);

-- Only one pending invite per email per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_email
    ON invites (tenant_id, email) WHERE status = 'pending';
