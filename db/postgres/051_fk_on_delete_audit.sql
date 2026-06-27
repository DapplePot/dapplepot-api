-- Complete FK audit cleanup. Without this migration, deleting any of
-- {tenants, users, agents} can fail with FK violations against tables
-- that were created without an ON DELETE handler in their original
-- migration.
--
-- Policy per FK:
--   tenant references     → CASCADE  (tenant data should disappear with tenant)
--   user references       → CASCADE for junk (tokens, resets) / SET NULL for
--                            history-bearing rows (invites, ownership)
--   agent references      → SET NULL on history tables (sessions, audit)
--
-- All changes are constraint-drop + constraint-add. Idempotent — DROP IF
-- EXISTS handles re-runs.

-- ── tenant FKs ───────────────────────────────────────────────────────────

ALTER TABLE invites
    DROP CONSTRAINT IF EXISTS invites_tenant_id_fkey;
ALTER TABLE invites
    ADD  CONSTRAINT invites_tenant_id_fkey
         FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE;

ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_tenant_id_fkey;
ALTER TABLE sessions
    ADD  CONSTRAINT sessions_tenant_id_fkey
         FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE;

ALTER TABLE alerts
    DROP CONSTRAINT IF EXISTS alerts_tenant_id_fkey;
ALTER TABLE alerts
    ADD  CONSTRAINT alerts_tenant_id_fkey
         FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE;

ALTER TABLE audit_archives
    DROP CONSTRAINT IF EXISTS audit_archives_tenant_id_fkey;
ALTER TABLE audit_archives
    ADD  CONSTRAINT audit_archives_tenant_id_fkey
         FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE;


-- ── user FKs (junk → CASCADE) ────────────────────────────────────────────

ALTER TABLE password_resets
    DROP CONSTRAINT IF EXISTS password_resets_user_id_fkey;
ALTER TABLE password_resets
    ADD  CONSTRAINT password_resets_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE refresh_tokens
    DROP CONSTRAINT IF EXISTS refresh_tokens_user_id_fkey;
ALTER TABLE refresh_tokens
    ADD  CONSTRAINT refresh_tokens_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;


-- ── user FKs (history → SET NULL, requires nullable column) ──────────────

ALTER TABLE invites
    ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE invites
    DROP CONSTRAINT IF EXISTS invites_invited_by_fkey;
ALTER TABLE invites
    ADD  CONSTRAINT invites_invited_by_fkey
         FOREIGN KEY (invited_by) REFERENCES users(user_id) ON DELETE SET NULL;

-- tenants.owner_user_id is already nullable (added in migration 038)
ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_owner_user_id_fkey;
ALTER TABLE tenants
    ADD  CONSTRAINT tenants_owner_user_id_fkey
         FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE SET NULL;


-- ── agent FKs (history → SET NULL) ───────────────────────────────────────

-- sessions.agent_id was already nullable in migration 012
ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_agent_id_fkey;
ALTER TABLE sessions
    ADD  CONSTRAINT sessions_agent_id_fkey
         FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL;

-- audit_archives.agent_id was already nullable in migration 023
ALTER TABLE audit_archives
    DROP CONSTRAINT IF EXISTS audit_archives_agent_id_fkey;
ALTER TABLE audit_archives
    ADD  CONSTRAINT audit_archives_agent_id_fkey
         FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL;
