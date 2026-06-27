-- DELETE on tenants was failing because users.tenant_id holds a FK with no
-- ON DELETE handler, so the existence of any user pointing at a tenant
-- blocks DELETE FROM tenants — including the user being deleted alongside
-- their own personal workspace via deleteUserById().
--
-- Semantics: users.tenant_id is a denormalized "active workspace" pointer
-- (the source of truth is tenant_members). If the active workspace is
-- deleted, the user's pointer should null out — the next login resolves
-- to whichever workspace they have access to from tenant_members.
--
-- Same fix as migration 049 (which handled the user→audit-log FKs); just
-- a different FK direction.

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_tenant_id_fkey;

ALTER TABLE users
    ADD  CONSTRAINT users_tenant_id_fkey
         FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE SET NULL;
