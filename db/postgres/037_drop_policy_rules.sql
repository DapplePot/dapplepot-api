-- Drop unused policy_rules table and alerts.rule_id column.
-- The policy_rules table was scaffolded for user-defined custom rules but
-- was never wired up; alerts.rule_id was always NULL in practice because
-- alert_delivery.py stripped the sentinel UUIDs before insert.

ALTER TABLE alerts DROP COLUMN IF EXISTS rule_id;
DROP INDEX IF EXISTS idx_rules_tenant_enabled;
DROP TABLE IF EXISTS policy_rules;
