import { Hono } from 'hono'
import { adminSearchUsers } from '../../queries/admin.pg.js'

type Variables = { tenantId: string; userId: string; role: string }

export const adminUsersRouter = new Hono<{ Variables: Variables }>()

// GET /admin/users?search=email — cross-tenant user lookup
adminUsersRouter.get('/', async (c) => {
    const search = c.req.query('search') ?? ''
    if (search.length < 2) {
        return c.json({ data: [] })   // Avoid full-table scans on empty queries
    }
    const users = await adminSearchUsers(search, Number(c.req.query('limit') ?? 50))
    return c.json({ data: users })
})
