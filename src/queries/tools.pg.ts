import { queryRow, queryRows } from '../lib/postgres.js'

export interface Tool {
  toolId:      string
  tenantId:    string
  name:        string
  description: string | null
  category:    string | null
  schema:      Record<string, unknown> | null
  createdAt:   string
  updatedAt:   string
}

interface RawTool extends Record<string, unknown> {
  tool_id:     string
  tenant_id:   string
  name:        string
  description: string | null
  category:    string | null
  schema:      unknown
  created_at:  Date
  updated_at:  Date
}

function mapTool(r: RawTool): Tool {
  let schema: Record<string, unknown> | null = null
  if (r.schema != null) {
    schema = typeof r.schema === 'string'
      ? JSON.parse(r.schema) as Record<string, unknown>
      : r.schema as Record<string, unknown>
  }
  return {
    toolId:      r.tool_id,
    tenantId:    r.tenant_id,
    name:        r.name,
    description: r.description,
    category:    r.category,
    schema,
    createdAt:   r.created_at.toISOString(),
    updatedAt:   r.updated_at.toISOString(),
  }
}

export async function listTools(tenantId: string): Promise<Tool[]> {
  const rows = await queryRows<RawTool>(
    `SELECT tool_id, tenant_id, name, description, category, schema, created_at, updated_at
     FROM tools
     WHERE tenant_id = $1::uuid
     ORDER BY name ASC`,
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
}): Promise<Tool> {
  const row = await queryRow<RawTool>(
    `INSERT INTO tools (tenant_id, name, description, category, schema)
     VALUES ($1::uuid, $2, $3, $4, $5)
     RETURNING tool_id, tenant_id, name, description, category, schema, created_at, updated_at`,
    [params.tenantId, params.name, params.description ?? null, params.category ?? null,
     params.schema != null ? JSON.stringify(params.schema) : null]
  )
  if (!row) throw new Error('Failed to create tool')
  return mapTool(row)
}

export async function updateToolSchema(
  tenantId: string,
  toolId:   string,
  schema:   Record<string, unknown> | null,
): Promise<Tool> {
  const row = await queryRow<RawTool>(
    `UPDATE tools
     SET schema = $3, updated_at = now()
     WHERE tenant_id = $1::uuid AND tool_id = $2::uuid
     RETURNING tool_id, tenant_id, name, description, category, schema, created_at, updated_at`,
    [tenantId, toolId, schema != null ? JSON.stringify(schema) : null]
  )
  if (!row) throw new Error('Tool not found')
  return mapTool(row)
}
