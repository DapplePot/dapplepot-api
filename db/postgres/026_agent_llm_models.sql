CREATE TABLE IF NOT EXISTS agent_llm_models (
    agent_id  UUID NOT NULL REFERENCES agents(agent_id)     ON DELETE CASCADE,
    model_id  UUID NOT NULL REFERENCES llm_models(model_id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id)   ON DELETE CASCADE,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_llm_models_agent  ON agent_llm_models (tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_llm_models_model  ON agent_llm_models (tenant_id, model_id);
