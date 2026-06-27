-- Subscription state for paid tiers (pro / team / enterprise).
--
-- Until Stripe ships (Phase 8 of the implementation plan), this table is
-- populated manually by the Superadmin Dashboard when a tenant upgrades.
-- stripe_subscription_id and stripe_customer_id are nullable and remain
-- NULL for manually-provisioned subscriptions; they are backfilled when
-- a tenant migrates to Stripe self-serve billing.
--
-- One row per tenant — the unique constraint on tenant_id enforces this.
-- A plan_tier change (e.g. pro → team) UPDATEs the row in place and bumps
-- updated_at, rather than creating a new row.
--
-- status semantics:
--   active     — billing current, full feature access
--   past_due   — payment failed, grace period before downgrade
--   cancelled  — user cancelled, access until current_period_end
--   paused     — admin-paused (rare; investigations, fraud holds, etc.)
--
-- Trial and Internal tiers do NOT have a row here — they're tracked
-- entirely on tenants.plan_tier and tenants.trial_ends_at.

CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL UNIQUE REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    plan_tier              TEXT        NOT NULL
                                       CHECK (plan_tier IN ('pro', 'team', 'enterprise')),
    billing_cycle          TEXT        NOT NULL
                                       CHECK (billing_cycle IN ('monthly', 'annual')),
    status                 TEXT        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('active', 'past_due', 'cancelled', 'paused')),
    current_period_start   TIMESTAMPTZ NOT NULL,
    current_period_end     TIMESTAMPTZ NOT NULL,
    cancel_at              TIMESTAMPTZ,
    stripe_subscription_id TEXT,
    stripe_customer_id     TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
    ON subscriptions (status)
    WHERE status IN ('past_due', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end
    ON subscriptions (current_period_end)
    WHERE status = 'active';

-- Fast Stripe-webhook lookup (NULL-tolerant; only enforced when present)
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_stripe_id
    ON subscriptions (stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;
