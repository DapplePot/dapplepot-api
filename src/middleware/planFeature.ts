/**
 * Reusable feature-gate middleware.
 *
 *   audit.ts:    auditRouter.use('*', requireFeature('canExportSealedAudit'))
 *   users.ts:    invite.use(requireFeature('canInviteTeammates'))
 *
 * Pulls the tenant's plan, then checks the named boolean feature flag.
 * Superadmin bypasses by design. Returns 403 with an upgrade hint if
 * the feature is unavailable for the tenant's tier.
 *
 * For collection-typed gates (e.g. "is THIS channel type allowed"),
 * read PlanLimits directly inside the route — this middleware only
 * handles boolean feature flags.
 */

import type { Context, Next } from 'hono'
import { getCurrentPlan } from '../queries/billing.pg.js'
import { type PlanLimits } from '../lib/planLimits.js'

type BooleanFeature = {
    [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never
}[keyof PlanLimits]

export function requireFeature(feature: BooleanFeature) {
    return async (c: Context, next: Next) => {
        const role = c.get('role') as string | undefined
        if (role === 'superadmin') return next()

        const tenantId = c.get('tenantId') as string | undefined
        if (!tenantId) {
            return c.json({ error: { code: 'UNAUTHORIZED' } }, 401)
        }

        const plan = await getCurrentPlan(tenantId)
        if (!plan) {
            return c.json({ error: { code: 'TENANT_NOT_FOUND' } }, 404)
        }

        if (!plan.limits[feature]) {
            return c.json(
                {
                    error: {
                        code: 'FEATURE_NOT_AVAILABLE',
                        message: `This feature is not available on the ${plan.limits.displayName} plan.`,
                        feature,
                        current_plan: plan.planTier,
                        upgrade_url: '/upgrade',
                    },
                },
                403
            )
        }

        await next()
    }
}
