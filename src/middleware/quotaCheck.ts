/**
 * Event-quota enforcement middleware.
 *
 * Mount in front of the ingest route. For each request:
 *   1. Resolves the tenant's current plan + open billing period.
 *   2. If the tenant is at/over quota AND on a tier without overage
 *      (currently every tier — see PLAN_LIMITS.*.overageBillable),
 *      rejects with 429.
 *   3. Otherwise, sets `quotaPolicy` on the request context so the
 *      ingest route knows whether to mark inserts as overage.
 *
 * The actual events_used increment happens in the ingest route AFTER
 * the ClickHouse write succeeds — see lib/usageTracker.ts. We do not
 * speculatively bump the counter here because failed inserts must
 * not be billed.
 */

import { createMiddleware } from 'hono/factory'
import { getCurrentPlan } from '../queries/billing.pg.js'
import { ensureCurrentPeriod } from '../lib/usageTracker.js'
import { type PlanTier } from '../lib/planLimits.js'

type Variables = {
    tenantId: string
    quotaPolicy: {
        plan: PlanTier
        eventsUsed: number
        eventsQuota: number
        overageAllowed: boolean
    }
}

export const quotaCheck = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const tenantId = c.get('tenantId') as string | undefined
    if (!tenantId) {
        // No tenant context — fail open here; auth middleware should have
        // already rejected. Anything that gets this far without tenantId
        // is a misconfiguration, not a user-facing error.
        return next()
    }

    const plan = await getCurrentPlan(tenantId)
    if (!plan || !plan.enabled) {
        return c.json(
            { error: { code: 'TENANT_DISABLED', message: 'Tenant is not active' } },
            403
        )
    }

    const period = await ensureCurrentPeriod(tenantId)
    const overageAllowed = plan.limits.overageBillable
    const overQuota = period.eventsUsed >= period.eventsQuota

    if (overQuota && !overageAllowed) {
        return c.json(
            {
                error: {
                    code: 'QUOTA_EXCEEDED',
                    message: `Monthly event quota of ${period.eventsQuota.toLocaleString()} reached. Upgrade to continue.`,
                    upgrade_url: '/upgrade',
                    quota: period.eventsQuota,
                    used:  period.eventsUsed,
                },
            },
            429
        )
    }

    c.set('quotaPolicy', {
        plan:           plan.planTier,
        eventsUsed:     period.eventsUsed,
        eventsQuota:    period.eventsQuota,
        overageAllowed,
    })
    await next()
})
