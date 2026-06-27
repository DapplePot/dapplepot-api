-- Add plan-tier columns to tenants for the 5-tier pricing model.
--   internal   — superadmin-granted, perpetual, 3 agents / 5k events / mo
--   trial      — self-serve 30-day free trial, 3 agents / 10k events total
--   pro        — $20/mo or $200/yr, unlimited agents / 50k events / mo / 1 seat
--   team       — $150/mo or $1,500/yr, unlimited agents / 350k events / mo / 5 seats
--   enterprise — superadmin-granted (post-sale), custom everything
--
-- All existing tenants default to 'internal' so they remain comped and
-- unlimited (operationally) until manually re-classified by a superadmin.
-- New tenants created via the self-serve signup flow get 'trial' and
-- trial_ends_at = now() + INTERVAL '30 days' (set by application code, not DB).
--
-- plan_changed_at is updated by application code on every plan_tier change,
-- and is the source of truth for "when did this tenant last change plan."

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS plan_tier        TEXT        NOT NULL DEFAULT 'internal'
        CHECK (plan_tier IN ('internal', 'trial', 'pro', 'team', 'enterprise')),
    ADD COLUMN IF NOT EXISTS trial_ends_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS plan_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_tenants_plan_tier
    ON tenants (plan_tier)
    WHERE enabled = true;

-- Fast lookup for the daily trial-expiry cron job
CREATE INDEX IF NOT EXISTS idx_tenants_trial_ends_at
    ON tenants (trial_ends_at)
    WHERE plan_tier = 'trial' AND trial_ends_at IS NOT NULL;
