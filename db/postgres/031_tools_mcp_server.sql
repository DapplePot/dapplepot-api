-- Link tools to their originating MCP server.
-- NULL = tool is defined locally (not from an MCP server).
-- ON DELETE SET NULL so deleting a server doesn't remove the tools.

ALTER TABLE tools
  ADD COLUMN IF NOT EXISTS mcp_server_id UUID REFERENCES mcp_servers(mcp_server_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tools_mcp_server ON tools (mcp_server_id) WHERE mcp_server_id IS NOT NULL;
