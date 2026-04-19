-- Per-tenant default notification channel config.
-- Consulted when an alert (e.g. from dapplepot-security) arrives with no explicit channels set.
CREATE TABLE IF NOT EXISTS tenant_notification_channels (
    channel_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    channel_type TEXT        NOT NULL CHECK (channel_type IN ('webhook', 'slack', 'pagerduty')),
    config       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_tenant_notification_channels_tenant
    ON tenant_notification_channels (tenant_id)
    WHERE enabled = true;
