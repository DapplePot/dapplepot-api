import { queryRows, queryRow } from '../lib/postgres.js'
import type { LlmModel } from './llm-models.pg.js'

interface AgentRow extends Record<string, unknown> {
    agent_id:       string
    tenant_id:      string
    name:           string
    description:    string | null
    latest_version: string | null
    created_at:     Date | string
    updated_at:     Date | string
}

export interface AgentSummary {
    agentId:       string
    tenantId:      string
    name:          string
    description:   string | null
    latestVersion: string | null
    createdAt:     string
    updatedAt:     string
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

function mapAgent(r: AgentRow): AgentSummary {
    return {
        agentId:       r.agent_id,
        tenantId:      r.tenant_id,
        name:          r.name,
        description:   r.description,
        latestVersion: r.latest_version,
        createdAt:     toIso(r.created_at),
        updatedAt:     toIso(r.updated_at),
    }
}

export async function listAgents(tenantId: string): Promise<AgentSummary[]> {
    const rows = await queryRows<AgentRow>(
        `SELECT agent_id, tenant_id, name, description, latest_version, created_at, updated_at
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
    tenantId:      string
    name:          string
    description:   string | null
    latestVersion: string | null
}): Promise<AgentSummary> {
    const row = await queryRow<AgentRow>(
        `INSERT INTO agents (tenant_id, name, description, latest_version)
         VALUES ($1, $2, $3, $4)
         RETURNING agent_id, tenant_id, name, description, latest_version, created_at, updated_at`,
        [params.tenantId, params.name, params.description, params.latestVersion]
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

export async function updateAgent(params: {
    tenantId:      string
    agentId:       string
    description:   string | null | undefined
    latestVersion: string | null | undefined
}): Promise<AgentSummary | null> {
    const row = await queryRow<AgentRow>(
        `UPDATE agents
         SET description   = COALESCE($3, description),
             latest_version = COALESCE($4, latest_version),
             updated_at    = now()
         WHERE tenant_id = $1 AND agent_id = $2
         RETURNING agent_id, tenant_id, name, description, latest_version, created_at, updated_at`,
        [params.tenantId, params.agentId, params.description ?? null, params.latestVersion ?? null]
    )
    return row ? mapAgent(row) : null
}

export async function deleteAgent(tenantId: string, agentId: string): Promise<void> {
    await queryRow(
        `DELETE FROM agents WHERE tenant_id = $1 AND agent_id = $2`,
        [tenantId, agentId]
    )
}

export async function getAgentLlmModels(tenantId: string, agentId: string): Promise<LlmModel[]> {
  const rows = await queryRows<{
    model_id: string; tenant_id: string; name: string; provider: string | null
    context_window_tokens: number | null
    input_cost_per_1k: string | null; output_cost_per_1k: string | null
    created_at: Date; updated_at: Date
  }>(
    `SELECT m.model_id, m.tenant_id, m.name, m.provider,
            m.context_window_tokens, m.input_cost_per_1k, m.output_cost_per_1k,
            m.created_at, m.updated_at
     FROM agent_llm_models alm
     JOIN llm_models m ON m.model_id = alm.model_id
     WHERE alm.tenant_id = $1::uuid AND alm.agent_id = $2::uuid
     ORDER BY m.name ASC`,
    [tenantId, agentId]
  )
  return rows.map(r => ({
    modelId:             r.model_id,
    tenantId:            r.tenant_id,
    name:                r.name,
    provider:            r.provider,
    contextWindowTokens: r.context_window_tokens,
    inputCostPer1k:      r.input_cost_per_1k  != null ? Number(r.input_cost_per_1k)  : null,
    outputCostPer1k:     r.output_cost_per_1k != null ? Number(r.output_cost_per_1k) : null,
    createdAt:           r.created_at.toISOString(),
    updatedAt:           r.updated_at.toISOString(),
  }))
}

export async function setAgentLlmModels(
  tenantId: string,
  agentId: string,
  modelIds: string[]
): Promise<void> {
  // Delete all existing mappings then re-insert — simple replace semantics
  await queryRow(
    `DELETE FROM agent_llm_models WHERE tenant_id = $1::uuid AND agent_id = $2::uuid`,
    [tenantId, agentId]
  )
  if (modelIds.length === 0) return
  for (const modelId of modelIds) {
    await queryRow(
      `INSERT INTO agent_llm_models (agent_id, model_id, tenant_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       ON CONFLICT DO NOTHING`,
      [agentId, modelId, tenantId]
    )
  }
}

export async function getAgentConnectedAgents(tenantId: string, agentId: string): Promise<AgentSummary[]> {
  const rows = await queryRows<AgentRow>(
    `SELECT a.agent_id, a.tenant_id, a.name, a.latest_version, a.created_at, a.updated_at
     FROM agent_connected_agents aca
     JOIN agents a ON a.agent_id = aca.connected_agent_id
     WHERE aca.tenant_id = $1::uuid AND aca.agent_id = $2::uuid
     ORDER BY a.name ASC`,
    [tenantId, agentId]
  )
  return rows.map(mapAgent)
}

export async function setAgentConnectedAgents(
  tenantId: string,
  agentId: string,
  connectedAgentIds: string[]
): Promise<void> {
  // Delete all existing mappings then re-insert — same replace semantics as setAgentLlmModels
  await queryRow(
    `DELETE FROM agent_connected_agents WHERE tenant_id = $1::uuid AND agent_id = $2::uuid`,
    [tenantId, agentId]
  )
  if (connectedAgentIds.length === 0) return
  for (const connectedId of connectedAgentIds) {
    await queryRow(
      `INSERT INTO agent_connected_agents (tenant_id, agent_id, connected_agent_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       ON CONFLICT DO NOTHING`,
      [tenantId, agentId, connectedId]
    )
  }
}
