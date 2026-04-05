import { queryRows, queryRow } from '../lib/postgres.js'

interface AgentRow extends Record<string, unknown> {
    agent_id: string
    tenant_id: string
    name: string
    latest_version: string | null
    created_at: Date | string
    updated_at: Date | string
}

export interface AgentSummary {
    agentId: string
    tenantId: string
    name: string
    latestVersion: string | null
    createdAt: string
    updatedAt: string
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

function mapAgent(r: AgentRow): AgentSummary {
    return {
        agentId: r.agent_id,
        tenantId: r.tenant_id,
        name: r.name,
        latestVersion: r.latest_version,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    }
}

export async function listAgents(tenantId: string): Promise<AgentSummary[]> {
    const rows = await queryRows<AgentRow>(
        `SELECT agent_id, tenant_id, name, latest_version, created_at, updated_at
         FROM agents
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId]
    )
    return rows.map(mapAgent)
}

export async function createAgent(params: {
    tenantId: string
    name: string
    latestVersion: string | null
}): Promise<AgentSummary> {
    const row = await queryRow<AgentRow>(
        `INSERT INTO agents (tenant_id, name, latest_version)
         VALUES ($1, $2, $3)
         RETURNING agent_id, tenant_id, name, latest_version, created_at, updated_at`,
        [params.tenantId, params.name, params.latestVersion]
    )
    if (!row) throw new Error('Failed to create agent')
    return mapAgent(row)
}
