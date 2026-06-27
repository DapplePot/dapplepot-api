-- Dedup table for transactional nudges (quota warnings, trial milestones).
--
-- Each (tenant_id, nudge_kind, period_anchor) is unique — re-dispatch
-- of the same nudge for the same anchor is a no-op. The anchor is one of:
--   - billing_period.period_id  (quota_80, quota_100)
--   - trial_ends_at ISO string  (trial_day_7, trial_day_25, trial_day_30, trial_day_37)
--
-- We don't store anchor as a typed column because it spans heterogeneous
-- references — TEXT keeps the table simple and lets us add new nudge
-- kinds without schema changes.
--
-- Cleanup: rows are not deleted. Long-running tenants accumulate one
-- row per (period × nudge_kind) which is ~6/month upper bound — cheap.

CREATE TABLE IF NOT EXISTS nudge_dispatch_log (
    dispatch_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    nudge_kind     TEXT        NOT NULL
        CHECK (nudge_kind IN (
            'quota_80', 'quota_100',
            'trial_day_7', 'trial_day_25', 'trial_day_30', 'trial_day_37'
        )),
    period_anchor  TEXT        NOT NULL,
    delivered_via  TEXT        NOT NULL CHECK (delivered_via IN ('email', 'in_app', 'both')),
    recipient      TEXT,
    error_message  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, nudge_kind, period_anchor)
);

CREATE INDEX IF NOT EXISTS idx_nudge_dispatch_log_tenant
    ON nudge_dispatch_log (tenant_id, created_at DESC);
