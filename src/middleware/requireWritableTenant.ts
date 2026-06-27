/**
 * requireWritableTenant — gates customer-facing routes by lifecycle_state.
 *
 * Replaces the older trialExpiry middleware (which was based on a 7-day grace
 * window). The new model uses an explicit lifecycle_state column promoted by
 * the daily lifecycle_transitions cron.
 *
 * Behaviour matrix:
 *
 *   lifecycle_state | READ  (GET/HEAD/OPTIONS) | WRITE (POST/PUT/PATCH/DELETE)
 *   ----------------+-------------------------+-------------------------------
 *   active          | pass                    | pass
 *   readonly        | pass                    | 402 TENANT_READ_ONLY
 *   suspended       | 402 TENANT_SUSPENDED    | 402 TENANT_SUSPENDED
 *   deleted         | 402 TENANT_SUSPENDED    | 402 TENANT_SUSPENDED   (account is being wiped imminently)
 *
 * Bypassed for superadmin and the limited routes mounted outside this
 * middleware (auth, me/plan, billing/*, leads/*).
 */

import { createMiddleware } from 'hono/factory'
import { queryRow } from '../lib/postgres.js'

type Variables = { tenantId: string; userId: string; role: string }

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export const requireWritableTenant = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const role = c.get('role')
    if (role === 'superadmin') return next()

    const tenantId = c.get('tenantId')
    if (!tenantId) return next()

    const row = await queryRow<{ lifecycle_state: 'active' | 'readonly' | 'suspended' | 'deleted' }>(
        `SELECT lifecycle_state FROM tenants WHERE tenant_id = $1`,
        [tenantId]
    )
    if (!row) return next()

    if (row.lifecycle_state === 'active') return next()

    if (row.lifecycle_state === 'readonly') {
        if (READ_METHODS.has(c.req.method)) return next()
        return c.json({
            error: {
                code:    'TENANT_READ_ONLY',
                message: 'Your account is in read-only mode. Upgrade to make changes.',
            },
        }, 402)
    }

    // suspended or deleted — block everything, kick the UI to the hard lock screen.
    return c.json({
        error: {
            code:    'TENANT_SUSPENDED',
            message: 'Your account is suspended. Upgrade to restore access.',
        },
    }, 402)
})
