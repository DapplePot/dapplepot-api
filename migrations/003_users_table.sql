CREATE TABLE IF NOT EXISTS users (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id),
    email         TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'editor', 'viewer')),
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_users_tenant_email UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
