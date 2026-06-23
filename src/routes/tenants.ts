import { Hono } from 'hono'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
const { hash: bcryptHash } = bcrypt
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { getTenantById, listTenants, onboardTenant } from '../queries/tenants.pg.js'

export const tenantsRouter = new Hono()

const OnboardSchema = z.object({
    tenant: z.object({
        name: z.string().min(1, 'tenant.name is required'),
        tokenBudget: z.number().int().positive().nullable().optional().default(null),
        rateLimit: z.number().int().positive().nullable().optional().default(null),
    }),
    admin: z.object({
        email: z.string().email('admin.email must be a valid email'),
        name: z.string().min(1, 'admin.name is required'),
        password: z.string().min(8, 'admin.password must be at least 8 characters'),
    }),
})

// GET /v1/tenants/:id — superadmin or the tenant's own users
tenantsRouter.get('/:id', jwtAuth, async (c) => {
    const id = c.req.param('id')
    const role = c.get('role')
    const callerTenantId = c.get('tenantId')

    if (role !== 'superadmin' && callerTenantId !== id) {
        return c.json({ error: 'Forbidden' }, 403)
    }

    const tenant = await getTenantById(id)
    if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
    return c.json(tenant)
})

// GET /v1/tenants — superadmin only
tenantsRouter.get('/', jwtAuth, requireRole('superadmin'), async (c) => {
    const tenants = await listTenants()
    return c.json(tenants)
})

tenantsRouter.post('/onboard', jwtAuth, requireRole('superadmin'), async (c) => {
    let body: unknown
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = OnboardSchema.safeParse(body)
    if (!parsed.success) {
        const first = parsed.error.errors[0]
        return c.json({ error: first?.message ?? 'Validation error' }, 400)
    }

    const { tenant, admin } = parsed.data

    const passwordHash = await bcryptHash(admin.password, 12)

    try {
        const result = await onboardTenant({
            tenantName: tenant.name,
            tokenBudget: tenant.tokenBudget ?? null,
            rateLimit: tenant.rateLimit ?? null,
            adminEmail: admin.email,
            adminName: admin.name,
            passwordHash,
        })
        return c.json(result, 201)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('23505') || msg.includes('unique') || msg.toLowerCase().includes('duplicate')) {
            return c.json({ error: 'Conflict creating tenant' }, 409)
        }
        return c.json({ error: 'Internal server error' }, 500)
    }
})
