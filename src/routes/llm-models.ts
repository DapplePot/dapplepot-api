import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { listLlmModels, createLlmModel } from '../queries/llm-models.pg.js'

export const llmModelsRouter = new Hono()

// GET /v1/llm-models — viewer+
llmModelsRouter.get('/', jwtAuth, requireRole('viewer'), async (c) => {
  const tenantId = c.get('tenantId')
  const models = await listLlmModels(tenantId)
  return c.json(models)
})

// POST /v1/llm-models — editor+
llmModelsRouter.post('/', jwtAuth, requireRole('editor'), async (c) => {
  const body = await c.req.json().catch(() => ({}))

  const parsed = z.object({
    name:                z.string().min(1),
    provider:            z.string().nullable().optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
    inputCostPer1k:      z.number().nonnegative().nullable().optional(),
    outputCostPer1k:     z.number().nonnegative().nullable().optional(),
  }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  const tenantId = c.get('tenantId')

  try {
    const model = await createLlmModel({
      tenantId,
      name:                parsed.data.name,
      provider:            parsed.data.provider ?? null,
      contextWindowTokens: parsed.data.contextWindowTokens ?? null,
      inputCostPer1k:      parsed.data.inputCostPer1k ?? null,
      outputCostPer1k:     parsed.data.outputCostPer1k ?? null,
    })
    return c.json(model, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('23505') || msg.toLowerCase().includes('unique')) {
      return c.json({ error: { code: 'CONFLICT', message: 'A model with this name already exists' } }, 409)
    }
    throw err
  }
})
