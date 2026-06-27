-- Onboarding gate.
--
-- onboarding_completed_at = NULL    → tenant is locked; user lands in the
--                                     forced plan-selection modal on every
--                                     dashboard load
-- onboarding_completed_at IS NOT NULL → tenant has chosen a plan; app unlocks
--
-- Three actors set this column:
--   1. self-signup → user picks Free Trial in modal:
--        sets onboarding_completed_at=now(), plan_tier='trial',
--        trial_ends_at=now()+30 days
--   2. self-signup → user picks Pro/Team in modal (pre-Stripe):
--        creates an upgrade_request; column stays NULL until superadmin
--        manually fulfills via the dashboard
--   3. superadmin creates Internal/Enterprise tenant from /admin/tenants/new:
--        adminCreateTenant() sets onboarding_completed_at=now() immediately
--        so the customer walks straight into their dashboard
--
-- Back-compat: existing tenants get onboarding_completed_at = created_at,
-- so legacy users aren't suddenly trapped behind a modal on next login.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

UPDATE tenants
SET onboarding_completed_at = created_at
WHERE onboarding_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_onboarding_pending
    ON tenants (created_at)
    WHERE onboarding_completed_at IS NULL;
