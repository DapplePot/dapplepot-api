import { queryRow, queryRows } from '../lib/postgres.js'

export interface LlmModel {
  modelId:             string
  tenantId:            string
  name:                string
  provider:            string | null
  contextWindowTokens: number | null
  inputCostPer1k:      number | null
  outputCostPer1k:     number | null
  createdAt:           string
  updatedAt:           string
}

interface RawModel extends Record<string, unknown> {
  model_id:               string
  tenant_id:              string
  name:                   string
  provider:               string | null
  context_window_tokens:  number | null
  input_cost_per_1k:      string | null
  output_cost_per_1k:     string | null
  created_at:             Date
  updated_at:             Date
}

function mapModel(r: RawModel): LlmModel {
  return {
    modelId:             r.model_id,
    tenantId:            r.tenant_id,
    name:                r.name,
    provider:            r.provider,
    contextWindowTokens: r.context_window_tokens,
    inputCostPer1k:      r.input_cost_per_1k  != null ? Number(r.input_cost_per_1k)  : null,
    outputCostPer1k:     r.output_cost_per_1k != null ? Number(r.output_cost_per_1k) : null,
    createdAt:           r.created_at.toISOString(),
    updatedAt:           r.updated_at.toISOString(),
  }
}

export async function listLlmModels(tenantId: string): Promise<LlmModel[]> {
  const rows = await queryRows<RawModel>(
    `SELECT model_id, tenant_id, name, provider, context_window_tokens,
            input_cost_per_1k, output_cost_per_1k, created_at, updated_at
     FROM llm_models
     WHERE tenant_id = $1::uuid
     ORDER BY name ASC`,
    [tenantId]
  )
  return rows.map(mapModel)
}

export async function createLlmModel(params: {
  tenantId:            string
  name:                string
  provider:            string | null
  contextWindowTokens: number | null
  inputCostPer1k:      number | null
  outputCostPer1k:     number | null
}): Promise<LlmModel> {
  const row = await queryRow<RawModel>(
    `INSERT INTO llm_models
       (tenant_id, name, provider, context_window_tokens, input_cost_per_1k, output_cost_per_1k)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     RETURNING model_id, tenant_id, name, provider, context_window_tokens,
               input_cost_per_1k, output_cost_per_1k, created_at, updated_at`,
    [
      params.tenantId,
      params.name,
      params.provider ?? null,
      params.contextWindowTokens ?? null,
      params.inputCostPer1k ?? null,
      params.outputCostPer1k ?? null,
    ]
  )
  if (!row) throw new Error('Failed to create LLM model')
  return mapModel(row)
}
