ALTER TABLE agent_alert_config
  ADD COLUMN IF NOT EXISTS tool_manifest            JSONB,
  ADD COLUMN IF NOT EXISTS privilege_scope          JSONB,
  ADD COLUMN IF NOT EXISTS max_tool_calls_per_session INT;
