CREATE TABLE IF NOT EXISTS sessions (
    session_id      UUID        PRIMARY KEY,
    tenant_id       UUID        NOT NULL REFERENCES tenants(tenant_id),
    agent_id        UUID        REFERENCES agents(agent_id),
    agent_version   TEXT,
    environment     TEXT,
    deployment_id   TEXT,
    user_context_id TEXT,
    status          TEXT        NOT NULL DEFAULT 'stub'
                                CHECK (status IN ('stub','open','finalised')),
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    last_active_at  TIMESTAMPTZ,
    duration_ms     INT,
    exit_reason     TEXT,
    version         INT         NOT NULL DEFAULT 1,
    last_seq        INT         NOT NULL DEFAULT 0,
    graph_state     JSONB,
    graph_runs      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    initial_input   JSONB,
    final_output    JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
