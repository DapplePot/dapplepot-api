-- Phase 8 pivot: dropped Stripe, picked Lemon Squeezy. Architecture stays
-- provider-agnostic so Razorpay can be added later for India-side
-- traffic with a routing layer in front.
--
-- Three changes:
--   1. Add `billing_provider` column on subscriptions (TEXT, default lemonsqueezy)
--   2. Rename Stripe-specific columns to provider-agnostic names
--   3. Same for tenants.stripe_customer_id

-- subscriptions ------------------------------------------------------------

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS billing_provider TEXT NOT NULL DEFAULT 'lemonsqueezy'
        CHECK (billing_provider IN ('lemonsqueezy', 'razorpay', 'stripe', 'manual'));

ALTER TABLE subscriptions
    RENAME COLUMN stripe_subscription_id TO external_subscription_id;

ALTER TABLE subscriptions
    RENAME COLUMN stripe_customer_id TO external_customer_id;

-- Drop the Stripe-only unique index and re-create on the new column name
DROP INDEX IF EXISTS uq_subscriptions_stripe_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_external_id
    ON subscriptions (billing_provider, external_subscription_id)
    WHERE external_subscription_id IS NOT NULL;


-- tenants ------------------------------------------------------------------

ALTER TABLE tenants
    RENAME COLUMN stripe_customer_id TO external_customer_id;

DROP INDEX IF EXISTS uq_tenants_stripe_customer_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_external_customer_id
    ON tenants (external_customer_id)
    WHERE external_customer_id IS NOT NULL;
