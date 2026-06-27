import { Hono } from 'hono'
import { listAuditLog, type AdminAction } from '../../queries/admin.pg.js'

type Variables = { tenantId: string; userId: string; role: string }

export const adminAuditLogRouter = new Hono<{ Variables: Variables }>()

// GET /admin/audit-log — filterable feed of every superadmin action
adminAuditLogRouter.get('/', async (c) => {
    const entries = await listAuditLog({
        actorUserId: c.req.query('actorUserId') ?? undefined,
        targetType:  (c.req.query('targetType') as 'tenant' | 'user' | 'subscription' | undefined) ?? undefined,
        targetId:    c.req.query('targetId') ?? undefined,
        action:      (c.req.query('action') as AdminAction | undefined) ?? undefined,
        limit:       Number(c.req.query('limit') ?? 100),
        offset:      Number(c.req.query('offset') ?? 0),
    })
    return c.json({ data: entries })
})
