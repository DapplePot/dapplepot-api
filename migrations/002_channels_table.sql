-- Delivery channel config table — owned entirely by dapplepot_api.
CREATE TABLE IF NOT EXISTS channels (
  channel_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  channel_type TEXT        NOT NULL CHECK (channel_type IN ('webhook','slack','pagerduty')),
  enabled      BOOLEAN     NOT NULL DEFAULT true,
  config       JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_tenant
  ON channels (tenant_id);
