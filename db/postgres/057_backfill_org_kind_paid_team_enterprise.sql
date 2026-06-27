-- Backfill: existing Team / Enterprise tenants that were left as kind='personal'
-- because an earlier version of handleSubscriptionActivated() didn't promote
-- kind when the subscription tier was multi-seat.
--
-- Symptom of the bug: paid Team customer logs in, Settings → Users tab is
-- hidden, can't invite teammates despite having paid for 5 seats.
--
-- Also stamps owner_user_id on any tenant where it's NULL but a tenant admin
-- exists — gives the new "Owner" protection in users.pg.ts something to
-- protect on tenants created before the column was wired into the signup flow.
--
-- Both UPDATEs are idempotent — re-running is a no-op.

-- 1. Promote Team / Enterprise tenants from personal → organization
UPDATE tenants
SET    kind       = 'organization',
       updated_at = now()
WHERE  plan_tier IN ('team', 'enterprise')
  AND  kind = 'personal';

-- 2. Stamp owner_user_id on any tenant that has an admin but no owner yet.
--    Picks the oldest active admin (the original creator) — that matches the
--    semantic intent of "owner" (the person who first built this workspace).
UPDATE tenants t
SET    owner_user_id = sub.user_id,
       updated_at    = now()
FROM   (
    SELECT DISTINCT ON (u.tenant_id)
           u.tenant_id,
           u.user_id
    FROM   users u
    WHERE  u.role = 'admin' AND u.status = 'active'
    ORDER  BY u.tenant_id, u.created_at ASC
) sub
WHERE  t.tenant_id     = sub.tenant_id
  AND  t.owner_user_id IS NULL;
