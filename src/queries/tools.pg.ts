import { queryRow, queryRows } from '../lib/postgres.js'

export interface Tool {
  toolId:        string
  tenantId:      string
  name:          string
  description:   string | null
  category:      string | null
  schema:        Record<string, unknown> | null
  version:       string | null
  mcpServerId:   string | null
  mcpServerName: string | null
  mcpServerUrl:  string | null
  createdAt:     string
  updatedAt:     string
}

interface RawTool extends Record<string, unknown> {
  tool_id:         string
  tenant_id:       string
  name:            string
  description:     string | null
  category:        string | null
  schema:          unknown
  version:         string | null
  mcp_server_id:   string | null
  mcp_server_name: string | null
  mcp_server_url:  string | null
  created_at:      Date
  updated_at:      Date
}

function mapTool(r: RawTool): Tool {
  let schema: Record<string, unknown> | null = null
  if (r.schema != null) {
    schema = typeof r.schema === 'string'
      ? JSON.parse(r.schema) as Record<string, unknown>
      : r.schema as Record<string, unknown>
  }
  return {
    toolId:        r.tool_id,
    tenantId:      r.tenant_id,
    name:          r.name,
    description:   r.description,
    category:      r.category,
    schema,
    version:       r.version,
    mcpServerId:   r.mcp_server_id,
    mcpServerName: r.mcp_server_name,
    mcpServerUrl:  r.mcp_server_url,
    createdAt:     r.created_at.toISOString(),
    updatedAt:     r.updated_at.toISOString(),
  }
}

const SELECT = `
  SELECT t.tool_id, t.tenant_id, t.name, t.description, t.category, t.schema, t.version,
         t.mcp_server_id, s.name AS mcp_server_name, s.url AS mcp_server_url,
         t.created_at, t.updated_at
  FROM tools t
  LEFT JOIN mcp_servers s ON s.mcp_server_id = t.mcp_server_id`

export async function listTools(tenantId: string): Promise<Tool[]> {
  const rows = await queryRows<RawTool>(
    `${SELECT}
     WHERE t.tenant_id = $1::uuid
     ORDER BY t.name ASC`,
    [tenantId]
  )
  return rows.map(mapTool)
}

export async function createTool(params: {
  tenantId:    string
  name:        string
  description: string | null
  category:    string | null
  schema:      Record<string, unknown> | null
  version:     string | null
}): Promise<Tool> {
  const row = await queryRow<RawTool>(
    `INSERT INTO tools (tenant_id, name, description, category, schema, version)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     RETURNING tool_id, tenant_id, name, description, category, schema, version,
               NULL AS mcp_server_id, NULL AS mcp_server_name, NULL AS mcp_server_url,
               created_at, updated_at`,
    [params.tenantId, params.name, params.description ?? null, params.category ?? null,
     params.schema != null ? JSON.stringify(params.schema) : null, params.version ?? null]
  )
  if (!row) throw new Error('Failed to create tool')
  return mapTool(row)
}

export async function updateTool(
  tenantId: string,
  toolId:   string,
  params: {
    description?:  string | null
    schema?:       Record<string, unknown> | null
    version?:      string | null
    mcpServerId?:  string | null
  }
): Promise<Tool> {
  const sets: string[] = []
  const values: unknown[] = [tenantId, toolId]
  if (params.description !== undefined) { values.push(params.description);                                           sets.push(`description = $${values.length}`) }
  if (params.schema !== undefined)      { values.push(params.schema != null ? JSON.stringify(params.schema) : null); sets.push(`schema = $${values.length}`) }
  if (params.version !== undefined)     { values.push(params.version);                                              sets.push(`version = $${values.length}`) }
  if (params.mcpServerId !== undefined) { values.push(params.mcpServerId);                                          sets.push(`mcp_server_id = $${values.length}::uuid`) }
  if (sets.length === 0) throw new Error('No fields to update')
  sets.push('updated_at = now()')

  const updated = await queryRow<{ tool_id: string }>(
    `UPDATE tools SET ${sets.join(', ')}
     WHERE tenant_id = $1::uuid AND tool_id = $2::uuid
     RETURNING tool_id`,
    values
  )
  if (!updated) throw new Error('Tool not found')

  const row = await queryRow<RawTool>(
    `${SELECT} WHERE t.tenant_id = $1::uuid AND t.tool_id = $2::uuid`,
    [tenantId, toolId]
  )
  if (!row) throw new Error('Tool not found')
  return mapTool(row)
}

export async function deleteTool(tenantId: string, toolId: string): Promise<void> {
  await queryRow(
    `DELETE FROM tools WHERE tenant_id = $1::uuid AND tool_id = $2::uuid RETURNING tool_id`,
    [tenantId, toolId]
  )
}

// Kept for backwards compatibility — callers that only update schema use this.
export async function updateToolSchema(
  tenantId: string,
  toolId:   string,
  schema:   Record<string, unknown> | null,
): Promise<Tool> {
  return updateTool(tenantId, toolId, { schema })
}
