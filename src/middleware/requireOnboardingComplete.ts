/**
 * requireOnboardingComplete — blocks every customer-facing route until the
 * user has confirmed a plan from the post-signup plan-selection modal.
 *
 * Returns 409 ONBOARDING_PENDING when the tenant exists but the gate is
 * still locked. The UI catches this code in its apiClient interceptor
 * and shows the locked-dashboard + plan-selection modal.
 *
 * Bypassed for:
 *   - superadmin (operates across all tenants by definition)
 *   - /v1/me/* routes (UI needs to load PlanSnapshot to render the modal)
 *   - /v1/auth/*  (login / logout / refresh must always work)
 *
 * Mount AFTER jwtAuth on every router whose handlers should be unreachable
 * until the customer has chosen a plan.
 */

import { createMiddleware } from 'hono/factory'
import { queryRow } from '../lib/postgres.js'

type Variables = { tenantId: string; userId: string; role: string }

export const requireOnboardingComplete = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const role = c.get('role')
    if (role === 'superadmin') return next()

    const tenantId = c.get('tenantId')
    if (!tenantId) return next()   // auth middleware should have caught this

    const row = await queryRow<{ onboarding_completed_at: Date | string | null }>(
        `SELECT onboarding_completed_at FROM tenants WHERE tenant_id = $1`,
        [tenantId]
    )
    if (row?.onboarding_completed_at) return next()

    return c.json({
        error: {
            code:    'ONBOARDING_PENDING',
            message: 'Plan selection required before using the platform.',
        },
    }, 409)
})
