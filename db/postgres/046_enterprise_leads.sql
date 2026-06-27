-- Pre-Stripe sales surfaces:
--   1. enterprise_leads  — "Contact Sales" form submissions (public)
--   2. upgrade_requests  — In-app "Request Upgrade" submissions from
--                          Free Trial / Pro tenants who want to move up
--                          while Stripe self-serve checkout doesn't exist
--                          yet (Phase 8 will replace this with Stripe Checkout)
--
-- Both feed into the Superadmin Dashboard so the founder team can
-- triage / quote / manually provision.

CREATE TABLE IF NOT EXISTS enterprise_leads (
    lead_id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     TEXT        NOT NULL,
    email                    TEXT        NOT NULL,
    company                  TEXT,
    monthly_volume_estimate  TEXT,
    deployment_preference    TEXT,
    compliance_needs         TEXT,
    notes                    TEXT,
    status                   TEXT        NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'contacted', 'qualified', 'won', 'lost')),
    assigned_to_user_id      UUID        REFERENCES users(user_id),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enterprise_leads_status
    ON enterprise_leads (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_enterprise_leads_assigned
    ON enterprise_leads (assigned_to_user_id, created_at DESC)
    WHERE assigned_to_user_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS upgrade_requests (
    request_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    requested_by_user_id UUID       NOT NULL REFERENCES users(user_id),
    current_plan_tier   TEXT        NOT NULL,
    requested_plan_tier TEXT        NOT NULL
        CHECK (requested_plan_tier IN ('pro', 'team', 'enterprise')),
    billing_cycle       TEXT        NOT NULL DEFAULT 'monthly'
        CHECK (billing_cycle IN ('monthly', 'annual')),
    trigger             TEXT
        CHECK (trigger IN ('agent_cap', 'event_quota', 'day_28_warning', 'day_31_expired', 'manual')),
    note                TEXT,
    status              TEXT        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'fulfilled', 'rejected', 'cancelled')),
    fulfilled_at        TIMESTAMPTZ,
    fulfilled_by_user_id UUID       REFERENCES users(user_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upgrade_requests_pending
    ON upgrade_requests (created_at DESC)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_upgrade_requests_tenant
    ON upgrade_requests (tenant_id, created_at DESC);
