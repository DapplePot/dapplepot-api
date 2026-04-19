CREATE TABLE IF NOT EXISTS policy_rules (
    rule_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    rule_type      TEXT        NOT NULL CHECK (rule_type IN (
                                   'threshold', 'content_match', 'schema_violation',
                                   'state_transition', 'rate', 'cumulative_cost',
                                   'sequence', 'session_duration'
                               )),
    eval_type      TEXT        NOT NULL CHECK (eval_type IN ('stateless', 'stateful')),
    enabled        BOOLEAN     NOT NULL DEFAULT true,
    config         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    dedup_window_s INT         NOT NULL DEFAULT 3600,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
