import { queryRow, queryRows } from '../lib/postgres.js'
import { chQuery } from '../lib/clickhouse.js'
import type { PolicyRule, DryRunResult } from '../types/rule.js'

function mapRule(r: Record<string, unknown>): PolicyRule {
  return {
    ruleId: r['rule_id'] as string,
    tenantId: r['tenant_id'] as string,
    name: r['name'] as string,
    ruleType: r['rule_type'] as PolicyRule['ruleType'],
    evalType: r['eval_type'] as PolicyRule['evalType'],
    enabled: r['enabled'] as boolean,
    config: r['config'] as Record<string, unknown>,
    dedupWindowS: r['dedup_window_s'] as number,
    createdAt: r['created_at'] instanceof Date
      ? (r['created_at'] as Date).toISOString()
      : String(r['created_at']),
    updatedAt: r['updated_at'] instanceof Date
      ? (r['updated_at'] as Date).toISOString()
      : String(r['updated_at']),
  }
}

export async function getRuleList(tenantId: string): Promise<PolicyRule[]> {
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT rule_id, tenant_id, name, rule_type, eval_type,
            enabled, config, dedup_window_s, created_at, updated_at
    FROM policy_rules
    WHERE tenant_id = $1
    ORDER BY created_at DESC`,
    [tenantId]
  )
  return rows.map(mapRule)
}

export async function createRule(
  tenantId: string,
  data: {
    name: string
    ruleType: string
    evalType: string
    enabled: boolean
    config: Record<string, unknown>
    dedupWindowS: number
  }
): Promise<PolicyRule> {
  const row = await queryRow<Record<string, unknown>>(
    `INSERT INTO policy_rules (tenant_id, name, rule_type, eval_type, enabled, config, dedup_window_s)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    RETURNING rule_id, tenant_id, name, rule_type, eval_type,
              enabled, config, dedup_window_s, created_at, updated_at`,
    [
      tenantId,
      data.name,
      data.ruleType,
      data.evalType,
      data.enabled,
      JSON.stringify(data.config),
      data.dedupWindowS,
    ]
  )
  if (!row) throw new Error('Failed to create rule')
  return mapRule(row)
}

export async function updateRule(
  tenantId: string,
  ruleId: string,
  data: {
    name?: string
    enabled?: boolean
    config?: Record<string, unknown>
    dedupWindowS?: number
  }
): Promise<PolicyRule | undefined> {
  const row = await queryRow<Record<string, unknown>>(
    `UPDATE policy_rules
    SET name           = COALESCE($3, name),
        enabled        = COALESCE($4, enabled),
        config         = COALESCE($5::jsonb, config),
        dedup_window_s = COALESCE($6, dedup_window_s),
        updated_at     = NOW()
    WHERE rule_id   = $1
      AND tenant_id = $2
    RETURNING rule_id, tenant_id, name, rule_type, eval_type,
              enabled, config, dedup_window_s, created_at, updated_at`,
    [
      ruleId,
      tenantId,
      data.name ?? null,
      data.enabled ?? null,
      data.config ? JSON.stringify(data.config) : null,
      data.dedupWindowS ?? null,
    ]
  )
  if (!row) return undefined
  return mapRule(row)
}

export async function dryRunRule(
  tenantId: string,
  agentId: string | null,
  threshold: number
): Promise<DryRunResult[]> {
  const rows = await chQuery<{ session_id: string; value: number }>(
    `SELECT
      session_id,
      sum(total_input_tok + total_output_tok) AS value
    FROM obs_session_tokens
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND ({agentId: String} = '' OR session_id IN (
            SELECT session_id FROM sessions
            WHERE tenant_id = {tenantId: String}
              AND agent_id  = {agentId: String}
          ))
      AND day >= today() - 7
    GROUP BY session_id
    HAVING value > {threshold: Float64}
    ORDER BY value DESC
    LIMIT 10`,
    { tenantId, agentId: agentId ?? '', threshold }
  )

  return rows.map((r) => ({
    sessionId: r.session_id,
    value: r.value,
    wouldFire: true,
  }))
}
