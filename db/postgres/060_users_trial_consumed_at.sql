-- Persist "this user has already consumed their free trial" so deleting a
-- personal workspace doesn't reset trial eligibility. Set by selectTrialPlan
-- when a user first picks Free Trial. Read by /me/plan + the onboarding flow
-- to decide whether the Free Trial card should appear.
--
-- NULL means "never claimed a trial" (eligible).
-- A timestamp means "already used trial on or after this date" (must pay to
-- create a new workspace).
--
-- Idempotent — re-running is a no-op.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS trial_consumed_at TIMESTAMPTZ;
