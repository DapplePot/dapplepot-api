-- Append-only audit log for Superadmin Dashboard actions.
--
-- Every plan change, quota override, tenant create/suspend/delete, user
-- role change, and other write performed via /admin/* routes is captured
-- here. before_value / after_value carry the relevant fields as JSONB
-- so a reader can diff the change without rejoining other tables.
--
-- Designed for forensic reading, not aggregations — index covers the
-- two common access patterns: "what did this superadmin do" and
-- "what was done to this tenant".

CREATE TABLE IF NOT EXISTS admin_audit_log (
    log_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID        NOT NULL REFERENCES users(user_id),
    action        TEXT        NOT NULL,           -- e.g. 'tenant.change_plan', 'tenant.suspend'
    target_type   TEXT        NOT NULL,           -- 'tenant' | 'user' | 'subscription'
    target_id     UUID,                           -- nullable for system-wide actions
    before_value  JSONB,
    after_value   JSONB,
    note          TEXT,                           -- optional human-readable reason
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor
    ON admin_audit_log (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target
    ON admin_audit_log (target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
    ON admin_audit_log (action, created_at DESC);
