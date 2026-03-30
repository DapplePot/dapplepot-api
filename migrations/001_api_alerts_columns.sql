-- Adds operational columns managed by dapplepot_api to the pipeline's alerts table.
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS status      TEXT        NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alerts_status
  ON alerts (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_alerts_triggered_tenant
  ON alerts (tenant_id, triggered_at DESC);
