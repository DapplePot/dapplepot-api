-- sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_time       ON sessions (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_agent_time ON sessions (tenant_id, agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_live              ON sessions (tenant_id, status)
    WHERE status != 'finalised';
CREATE INDEX IF NOT EXISTS idx_sessions_stale             ON sessions (last_active_at)
    WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_sessions_graph_state_gin   ON sessions USING GIN (graph_state jsonb_path_ops);

-- alerts indexes
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_time ON alerts (tenant_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_session     ON alerts (tenant_id, session_id, triggered_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts (dedup_key, triggered_at);

-- policy_rules index
CREATE INDEX IF NOT EXISTS idx_rules_tenant_enabled ON policy_rules (tenant_id, enabled)
    INCLUDE (rule_type, eval_type) WHERE enabled = true;
