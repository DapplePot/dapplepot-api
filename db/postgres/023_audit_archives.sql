CREATE TABLE IF NOT EXISTS audit_archives (
    archive_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(tenant_id),
    agent_id        UUID        REFERENCES agents(agent_id),
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'sealing'
                                CHECK (status IN ('sealing', 'sealed', 'failed')),
    sha256          TEXT,
    session_count   INT         NOT NULL DEFAULT 0,
    event_count     INT         NOT NULL DEFAULT 0,
    finding_count   INT         NOT NULL DEFAULT 0,
    alert_count     INT         NOT NULL DEFAULT 0,
    payload         JSONB,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sealed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_archives_tenant
    ON audit_archives (tenant_id, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_audit_archives_agent
    ON audit_archives (tenant_id, agent_id, period_start DESC);
