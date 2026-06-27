-- Per-tenant monthly usage windows.
--
-- Every paid tenant (and trial / internal tenants too — quota applies to
-- everyone) has at most one OPEN period at a time. The period_end of an
-- open period is "the next monthly boundary." When the boundary passes,
-- a cron job (scripts/close_billing_period.ts) closes the period by
-- setting closed_at = now() and inserts the next period.
--
-- events_used is incremented async by the ingestion path AFTER successful
-- ClickHouse write — eventual consistency is fine for billing because the
-- ground truth (obs_events row count) can always be reconciled if drift
-- exceeds tolerance.
--
-- overage_events is set when events_used crosses events_quota and only
-- applies to paid tiers (pro / team / enterprise) — trial enforces a
-- hard cap at quota (no overage).
--
-- For trial tenants, period_start is the trial start, period_end is the
-- trial end, and events_quota is the trial total (10k by default). For
-- pro/team/enterprise/internal, periods are calendar-monthly.

CREATE TABLE IF NOT EXISTS billing_periods (
    period_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    period_start   TIMESTAMPTZ NOT NULL,
    period_end     TIMESTAMPTZ NOT NULL,
    events_used    BIGINT      NOT NULL DEFAULT 0,
    events_quota   BIGINT      NOT NULL,
    overage_events BIGINT      NOT NULL DEFAULT 0,
    closed_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, period_start)
);

-- Hot-path index: find the open period for a tenant on every ingest
CREATE INDEX IF NOT EXISTS idx_billing_periods_tenant_open
    ON billing_periods (tenant_id)
    WHERE closed_at IS NULL;

-- Cron-job index: find all periods ready to close
CREATE INDEX IF NOT EXISTS idx_billing_periods_ready_to_close
    ON billing_periods (period_end)
    WHERE closed_at IS NULL;
