import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { requireRole } from '../../src/middleware/authorize.js'

type Role = 'admin' | 'editor' | 'viewer'

/**
 * Build a minimal Hono app that:
 *   1. Injects `role` into context via a fake auth middleware
 *   2. Runs requireRole(minimumRole) as the second middleware
 *   3. Returns 200 { ok: true } if the middleware passes
 */
function buildApp(minimumRole: Role) {
    const app = new Hono<{ Variables: { role: string } }>()
    // The role is injected by the route itself (simulates jwtAuth setting it)
    app.get('/test/:role', async (c, next) => {
        c.set('role', c.req.param('role') ?? 'viewer')
        await next()
    }, requireRole(minimumRole), (c) => c.json({ ok: true }))
    return app
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request(app: any, role: string): Promise<Response> {
    return (app as Hono).request(`/test/${role}`)
}

describe('requireRole("viewer") — everyone can access', () => {
    const app = buildApp('viewer')

    it('allows viewer', async () => {
        const res = await request(app, 'viewer')
        expect(res.status).toBe(200)
    })

    it('allows editor', async () => {
        const res = await request(app, 'editor')
        expect(res.status).toBe(200)
    })

    it('allows admin', async () => {
        const res = await request(app, 'admin')
        expect(res.status).toBe(200)
    })
})

describe('requireRole("editor") — editor+ can access', () => {
    const app = buildApp('editor')

    it('blocks viewer with 403', async () => {
        const res = await request(app, 'viewer')
        expect(res.status).toBe(403)
        const body = await res.json() as Record<string, unknown>
        expect((body['error'] as Record<string, unknown>)['code']).toBe('FORBIDDEN')
    })

    it('allows editor', async () => {
        const res = await request(app, 'editor')
        expect(res.status).toBe(200)
    })

    it('allows admin', async () => {
        const res = await request(app, 'admin')
        expect(res.status).toBe(200)
    })
})

describe('requireRole("admin") — admin only', () => {
    const app = buildApp('admin')

    it('blocks viewer with 403', async () => {
        const res = await request(app, 'viewer')
        expect(res.status).toBe(403)
    })

    it('blocks editor with 403', async () => {
        const res = await request(app, 'editor')
        expect(res.status).toBe(403)
        const body = await res.json() as Record<string, unknown>
        expect((body['error'] as Record<string, unknown>)['message']).toBe('Insufficient permissions')
    })

    it('allows admin', async () => {
        const res = await request(app, 'admin')
        expect(res.status).toBe(200)
    })
})

describe('requireRole with unknown role', () => {
    const app = buildApp('editor')

    it('blocks unknown/garbage role with 403', async () => {
        // An unknown role value like 'superuser' has no rank, treated as rank 0
        const res = await app.request('/test/superuser')
        expect(res.status).toBe(403)
    })
})

describe('403 response shape', () => {
    const app = buildApp('admin')

    it('returns JSON with error.code = FORBIDDEN and error.message', async () => {
        const res = await request(app, 'viewer')
        const body = await res.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe('FORBIDDEN')
        expect(typeof body.error.message).toBe('string')
        expect(body.error.message.length).toBeGreaterThan(0)
    })
})
