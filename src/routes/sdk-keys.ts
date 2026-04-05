import { Hono } from 'hono'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { listSdkKeys, revealSdkKey } from '../queries/sdk-keys.pg.js'

export const sdkKeysRouter = new Hono()

// GET /v1/sdk-keys — viewer+
sdkKeysRouter.get('/', jwtAuth, requireRole('viewer'), async (c) => {
    const tenantId = c.get('tenantId')
    const keys = await listSdkKeys(tenantId)
    return c.json(keys)
})

// GET /v1/sdk-keys/:keyId/reveal — admin only
sdkKeysRouter.get('/:keyId/reveal', jwtAuth, requireRole('admin'), async (c) => {
    const tenantId = c.get('tenantId')
    const keyId = c.req.param('keyId')

    const key = await revealSdkKey(tenantId, keyId)
    if (key === undefined) {
        return c.json({ error: 'Not found' }, 404)
    }
    return c.json({ key })
})
