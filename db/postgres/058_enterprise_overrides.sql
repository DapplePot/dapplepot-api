-- Per-tenant Enterprise overrides for seats + events quota.
--
-- The base planLimits.ts has Enterprise as "null = unlimited" because each
-- contract specifies its own numbers. These columns let the superadmin
-- specify the actual contracted limits at provision time so quota/seat
-- enforcement works correctly for Enterprise customers.
--
-- Both columns are NULL for all non-Enterprise tenants — those use the
-- defaults from planLimits.ts as before.
--
-- Idempotent: re-running this migration does nothing.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS enterprise_seats_cap         INT,
    ADD COLUMN IF NOT EXISTS enterprise_events_per_period BIGINT;

-- Sanity: must be positive when set
ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_enterprise_seats_cap_check;
ALTER TABLE tenants
    ADD  CONSTRAINT tenants_enterprise_seats_cap_check
         CHECK (enterprise_seats_cap IS NULL OR enterprise_seats_cap > 0);

ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_enterprise_events_per_period_check;
ALTER TABLE tenants
    ADD  CONSTRAINT tenants_enterprise_events_per_period_check
         CHECK (enterprise_events_per_period IS NULL OR enterprise_events_per_period > 0);
