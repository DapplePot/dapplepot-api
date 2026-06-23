-- Tenant names no longer need to be globally unique. Personal workspaces
-- frequently share a base ("Jane's workspace") and forcing uniqueness pushed
-- us into appending a random suffix that leaked into the UI. The tenant_id
-- is the real identity; name is just a label.

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_name_key;
