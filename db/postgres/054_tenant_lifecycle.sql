-- Tenant lifecycle state machine — replaces the old 7-day grace concept.
--
--   active     → normal operation (paid tiers, internal, fresh trials)
--   readonly   → trial ended; can view existing data but cannot ingest,
--                create agents/channels, or change config
--   suspended  → hard lock; user sees only the upgrade screen, nothing else
--   deleted    → soft-marker that the daily cron has scheduled data wipe
--
-- State transitions for self-signup Free Trial users:
--   day 0   → 30  : active
--   day 31  → 120 : readonly
--   day 121 → 210 : suspended
--   day 211+      : deleted (data physically removed by delete_expired_tenants.ts)
--
-- For paid (pro/team) and Internal/Enterprise tenants, state stays 'active'.
-- Cancellations from Stripe-equivalent flow set state='readonly' first, then
-- the daily lifecycle cron promotes through the same windows.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle_state IN ('active', 'readonly', 'suspended', 'deleted')),
    ADD COLUMN IF NOT EXISTS lifecycle_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Fast lookup for the daily lifecycle-transitions cron
CREATE INDEX IF NOT EXISTS idx_tenants_lifecycle_state
    ON tenants (lifecycle_state, lifecycle_changed_at)
    WHERE enabled = true;
