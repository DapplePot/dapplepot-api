import { Hono } from 'hono'
import { getPlatformStats } from '../../queries/admin.pg.js'

type Variables = { tenantId: string; userId: string; role: string }

export const adminUsageRouter = new Hono<{ Variables: Variables }>()

// GET /admin/usage — platform-wide stats
adminUsageRouter.get('/', async (c) => {
    const stats = await getPlatformStats()
    return c.json(stats)
})
