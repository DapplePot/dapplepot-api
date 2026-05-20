-- MCP server inventory: one row per registered MCP server endpoint per tenant.
-- name        — user-friendly label (e.g. "Internal DB Server")
-- url         — the endpoint URL agents connect to (e.g. "https://mcp.internal/tools")
-- description — what this server does; used by ASCV-02a as the trusted baseline

CREATE TABLE IF NOT EXISTS mcp_servers (
    mcp_server_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    url           TEXT        NOT NULL,
    description   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, url)
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant ON mcp_servers (tenant_id);
