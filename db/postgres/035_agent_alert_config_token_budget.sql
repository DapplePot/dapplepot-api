ALTER TABLE agent_alert_config
  ADD COLUMN IF NOT EXISTS token_budget_usd NUMERIC(10, 4);
