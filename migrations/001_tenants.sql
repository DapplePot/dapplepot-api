CREATE TABLE IF NOT EXISTS tenants (
    tenant_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT        NOT NULL UNIQUE,
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    token_budget BIGINT,
    rate_limit   INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sdk_keys (
    key_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    key_hash     TEXT        NOT NULL UNIQUE,
    name         TEXT,
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sdk_keys_hash ON sdk_keys (key_hash) WHERE enabled = true;
