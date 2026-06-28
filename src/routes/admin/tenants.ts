import { Hono } from 'hono'
import { z } from 'zod'
import {
    adminGetTenant,
    adminCreateTenant,
    adminChangePlan,
    adminSuspendTenant,
    adminRestoreTenant,
} from '../../queries/admin.pg.js'
import { listTenantsForAdmin, getPlanSnapshot } from '../../queries/billing.pg.js'

type Variables = { tenantId: string; userId: string; role: string }

export const adminTenantsRouter = new Hono<{ Variables: Variables }>()

const PlanTierSchema = z.enum(['internal', 'trial', 'pro', 'team', 'enterprise'])

// GET /admin/tenants — list with filters
adminTenantsRouter.get('/', async (c) => {
    const planTier = c.req.query('planTier')
    const enabled  = c.req.query('enabled')
    const search   = c.req.query('search') ?? undefined
    const limit    = Number(c.req.query('limit') ?? 50)
    const offset   = Number(c.req.query('offset') ?? 0)

    const tenants = await listTenantsForAdmin({
        planTier: PlanTierSchema.safeParse(planTier).success ? (planTier as never) : undefined,
        enabled:  enabled === undefined ? undefined : enabled === 'true',
        search,
        limit,
        offset,
    })
    return c.json({ data: tenants })
})

// GET /admin/tenants/:id — full detail (plan + subscription + usage + counts)
adminTenantsRouter.get('/:id', async (c) => {
    const tenantId = c.req.param('id')
    const snapshot = await getPlanSnapshot(tenantId)
    if (!snapshot) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
    }
    const detail = await adminGetTenant(tenantId)
    return c.json({ tenant: detail, snapshot })
})

// POST /admin/tenants — create new tenant (used for Internal + Enterprise)
const CreateTenantSchema = z.object({
    name:     z.string().min(1),
    kind:     z.enum(['personal', 'organization']),
    planTier: PlanTierSchema,
    note:     z.string().optional(),
})

adminTenantsRouter.post('/', async (c) => {
    const actorUserId = c.get('userId')
    let body: unknown
    try { body = await c.req.json() } catch {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400)
    }
    const parsed = CreateTenantSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'Validation error' } }, 400)
    }
    try {
        const d = parsed.data
        const tenant = await adminCreateTenant({
            actorUserId,
            name:     d.name!,
            kind:     d.kind!,
            planTier: d.planTier!,
            note:     d.note,
        })
        return c.json(tenant, 201)
    } catch (err) {
        const msg = (err as Error).message
        return c.json({ error: { code: 'CREATE_FAILED', message: msg } }, 500)
    }
})

// PATCH /admin/tenants/:id — change plan_tier (and other mutations)
const PatchTenantSchema = z.object({
    planTier: PlanTierSchema.optional(),
    suspend:  z.boolean().optional(),
    restore:  z.boolean().optional(),
    note:     z.string().optional(),
}).refine(
    d => d.planTier !== undefined || d.suspend !== undefined || d.restore !== undefined,
    { message: 'At least one of planTier, suspend, restore is required' }
)

adminTenantsRouter.patch('/:id', async (c) => {
    const actorUserId = c.get('userId')
    const tenantId    = c.req.param('id')

    let body: unknown
    try { body = await c.req.json() } catch {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400)
    }
    const parsed = PatchTenantSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'Validation error' } }, 400)
    }

    let result
    try {
        if (parsed.data.planTier) {
            result = await adminChangePlan({
                actorUserId, tenantId,
                newPlanTier: parsed.data.planTier,
                note: parsed.data.note,
            })
        }
        if (parsed.data.suspend) {
            result = await adminSuspendTenant({ actorUserId, tenantId, note: parsed.data.note })
        }
        if (parsed.data.restore) {
            result = await adminRestoreTenant({ actorUserId, tenantId, note: parsed.data.note })
        }
    } catch (err) {
        return c.json({ error: { code: 'UPDATE_FAILED', message: (err as Error).message } }, 500)
    }
    return c.json(result)
})
