-- Fix the mis-named UNIQUE constraint on invites.
--
-- Migration 005 added `CONSTRAINT uq_invites_tenant_email_pending UNIQUE
-- (tenant_id, email)` — the *name* implies "only one pending invite per
-- (tenant, email)" but the constraint itself has no WHERE clause, so it
-- forbids re-inviting an email after the prior invite was accepted /
-- expired / revoked. The intended one-pending-only behaviour is already
-- enforced by `idx_invites_pending_email` (partial unique on status='pending').
--
-- This migration drops the over-broad constraint so re-invites work.
-- The partial pending-only uniqueness stays as the real guard.
--
-- Symptom of the bug: PostgresError 23505 on /v1/users/invite when the
-- target email has any historical invite row in this tenant.

ALTER TABLE invites
    DROP CONSTRAINT IF EXISTS uq_invites_tenant_email_pending;
