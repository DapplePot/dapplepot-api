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

// Bayesian prior: Beta(α=2, β=8) → starting trust = 100 × (1 − 2/10) = 80
const _TRUST_PRIOR_SCORE = 80.0
const _TRUST_PRIOR_ALPHA = 2.0
const _TRUST_PRIOR_BETA  = 8.0

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

    // Seed agent_risk_scores with the Bayesian prior so the trust card shows
    // immediately on the profile page — before any session has been scored.
    // ON CONFLICT DO NOTHING: if the scorer has already written a row, leave it.
    await queryRow(
        `INSERT INTO agent_risk_scores
             (agent_id, tenant_id, session_count,
              avg_llm_score, avg_asi_score,
              max_llm_score, max_asi_score,
              trust_score, trust_trend, trust_trend_slope,
              trust_alpha, trust_beta,
              last_scored_at)
         VALUES ($1, $2, 0, 0, 0, 0, 0, $3, 'stable', 0, $4, $5, now())
         ON CONFLICT (agent_id) DO NOTHING`,
        [row.agent_id, params.tenantId,
         _TRUST_PRIOR_SCORE, _TRUST_PRIOR_ALPHA, _TRUST_PRIOR_BETA]
    )

    return mapAgent(row)
}
