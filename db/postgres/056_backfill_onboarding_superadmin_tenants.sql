-- Backfill onboarding_completed_at for existing superadmin-provisioned tenants.
--
-- Reason: an earlier version of onboardTenant() (used by /tenants page's
-- "Onboard a client" wizard) did not set onboarding_completed_at, so tenants
-- created before that fix have a NULL timestamp and get blocked by the
-- requireOnboardingComplete middleware on every gated route with 409
-- ONBOARDING_PENDING.
--
-- All Internal (comp) and Enterprise (post-sale) tenants are by definition
-- superadmin-provisioned — the customer-facing plan-selection modal does
-- not apply to them. Backfill them all to the safe "already onboarded" state.
--
-- This migration is idempotent: re-running it is a no-op because the
-- WHERE clause excludes rows that already have a timestamp.

UPDATE tenants
SET    onboarding_completed_at = now(),
       updated_at               = now()
WHERE  plan_tier IN ('internal', 'enterprise')
  AND  onboarding_completed_at IS NULL;
