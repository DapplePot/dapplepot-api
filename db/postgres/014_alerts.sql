CREATE TABLE IF NOT EXISTS alerts (
    alert_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(tenant_id),
    session_id   UUID,
    rule_id      UUID        REFERENCES policy_rules(rule_id),
    rule_name    TEXT,
    severity     TEXT        NOT NULL DEFAULT 'medium',
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dedup_key    TEXT        NOT NULL,
    payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
