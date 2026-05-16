-- Connected agents registry for IAC-05a (Unknown agent in delegation chain).
-- Each row declares that agent_id is permitted to delegate to connected_agent_id.
-- The security scorer checks incoming delegations against this list instead of
-- querying all agents in the tenant — same pattern as agent_llm_models / connected LLMs.

CREATE TABLE IF NOT EXISTS agent_connected_agents (
    tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id)   ON DELETE CASCADE,
    agent_id           UUID NOT NULL REFERENCES agents(agent_id)     ON DELETE CASCADE,
    connected_agent_id UUID NOT NULL REFERENCES agents(agent_id)     ON DELETE CASCADE,
    added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent_id, connected_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_connected_agents_parent
    ON agent_connected_agents (tenant_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_connected_agents_child
    ON agent_connected_agents (tenant_id, connected_agent_id);
