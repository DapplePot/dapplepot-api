-- Multi-tenant membership.
--
-- Until this migration, users.tenant_id was the single source of truth for
-- which tenant a user belonged to, so a person who needed access to two
-- tenants ended up with two completely separate user rows (different
-- user_id, different password). That made it impossible for one identity
-- to span workspaces.
--
-- This migration introduces tenant_members as a proper join table. After it:
--   - users.email is globally unique (one identity per email)
--   - tenant_members(user_id, tenant_id, role) holds workspace membership
--   - users.tenant_id stays as a denormalized "active workspace" pointer,
--     so existing tenant-scoped queries that read c.tenantId from the JWT
--     continue to work. It is updated whenever the user switches workspaces.
--   - users.role is similarly snapshot from the active tenant's member role.

CREATE TABLE IF NOT EXISTS tenant_members (
    user_id    UUID        NOT NULL REFERENCES users(user_id)   ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user   ON tenant_members (user_id);

-- Backfill every existing tenant-scoped user as a member of their tenant.
-- Superadmins (tenant_id IS NULL) are global operators, not tenant members.
INSERT INTO tenant_members (user_id, tenant_id, role, joined_at)
SELECT user_id, tenant_id, role, created_at
FROM users
WHERE tenant_id IS NOT NULL
  AND role IN ('admin', 'editor', 'viewer')
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- Email is now a global identity. Drop the old per-tenant uniqueness rules.
-- NOTE: if existing data has the same email in multiple tenants, this will
-- fail. In that case the duplicates must be merged manually before re-running.
ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_tenant_email;
DROP INDEX IF EXISTS uq_users_superadmin_email;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
    ON users (LOWER(email));
