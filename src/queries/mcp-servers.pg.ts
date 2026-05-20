import { queryRow, queryRows } from '../lib/postgres.js'

export interface McpServer {
  mcpServerId: string
  tenantId:    string
  name:        string
  url:         string
  description: string | null
  toolCount:   number
  createdAt:   string
  updatedAt:   string
}

interface RawMcpServer extends Record<string, unknown> {
  mcp_server_id: string
  tenant_id:     string
  name:          string
  url:           string
  description:   string | null
  tool_count:    string | number
  created_at:    Date
  updated_at:    Date
}

function mapMcpServer(r: RawMcpServer): McpServer {
  return {
    mcpServerId: r.mcp_server_id,
    tenantId:    r.tenant_id,
    name:        r.name,
    url:         r.url,
    description: r.description,
    toolCount:   Number(r.tool_count),
    createdAt:   r.created_at.toISOString(),
    updatedAt:   r.updated_at.toISOString(),
  }
}

export async function listMcpServers(tenantId: string): Promise<McpServer[]> {
  const rows = await queryRows<RawMcpServer>(
    `SELECT s.mcp_server_id, s.tenant_id, s.name, s.url, s.description,
            s.created_at, s.updated_at,
            COUNT(t.tool_id) AS tool_count
     FROM mcp_servers s
     LEFT JOIN tools t ON t.mcp_server_id = s.mcp_server_id
     WHERE s.tenant_id = $1::uuid
     GROUP BY s.mcp_server_id
     ORDER BY s.name ASC`,
    [tenantId]
  )
  return rows.map(mapMcpServer)
}

export async function createMcpServer(params: {
  tenantId:    string
  name:        string
  url:         string
  description: string | null
}): Promise<McpServer> {
  const row = await queryRow<RawMcpServer>(
    `INSERT INTO mcp_servers (tenant_id, name, url, description)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING mcp_server_id, tenant_id, name, url, description, created_at, updated_at,
               0 AS tool_count`,
    [params.tenantId, params.name, params.url, params.description ?? null]
  )
  if (!row) throw new Error('Failed to create MCP server')
  return mapMcpServer(row)
}

export async function updateMcpServer(
  tenantId:    string,
  serverId:    string,
  params: {
    name?:        string
    url?:         string
    description?: string | null
  }
): Promise<McpServer> {
  const sets: string[] = []
  const values: unknown[] = [tenantId, serverId]
  if (params.name !== undefined)        { values.push(params.name);        sets.push(`name = $${values.length}`) }
  if (params.url !== undefined)         { values.push(params.url);         sets.push(`url = $${values.length}`) }
  if (params.description !== undefined) { values.push(params.description); sets.push(`description = $${values.length}`) }
  if (sets.length === 0) throw new Error('No fields to update')
  sets.push('updated_at = now()')

  const row = await queryRow<RawMcpServer>(
    `UPDATE mcp_servers
     SET ${sets.join(', ')}
     WHERE tenant_id = $1::uuid AND mcp_server_id = $2::uuid
     RETURNING mcp_server_id, tenant_id, name, url, description, created_at, updated_at,
               (SELECT COUNT(*) FROM tools WHERE mcp_server_id = $2::uuid) AS tool_count`,
    values
  )
  if (!row) throw new Error('MCP server not found')
  return mapMcpServer(row)
}

export async function deleteMcpServer(tenantId: string, serverId: string): Promise<void> {
  await queryRow(
    `DELETE FROM mcp_servers
     WHERE tenant_id = $1::uuid AND mcp_server_id = $2::uuid
     RETURNING mcp_server_id`,
    [tenantId, serverId]
  )
}
