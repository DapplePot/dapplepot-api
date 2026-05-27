ALTER TABLE agent_alert_config
  ADD COLUMN IF NOT EXISTS tool_approval_policy JSONB DEFAULT NULL;
