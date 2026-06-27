-- Phase 8: Stripe customer ID on tenants.
--
-- We already track stripe_customer_id on subscriptions, but storing it on
-- tenants too lets us:
--   1. Reuse the same Customer across plan switches (Pro → Team → cancel
--      → re-subscribe) — the saved payment method survives.
--   2. Look up the customer from a webhook in O(1) before any
--      subscription row exists (e.g. checkout.session.completed for a
--      brand-new subscriber).
--
-- One Stripe customer per tenant. The UNIQUE constraint enforces this so
-- a duplicate webhook can't fork a tenant into multiple customers.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_stripe_customer_id
    ON tenants (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;
