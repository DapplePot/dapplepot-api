/**
 * /v1/me/* — endpoints scoped to the calling user's own tenant.
 *
 *   GET /v1/me/plan   — full PlanSnapshot (used by the UI plan/usage hook)
 *
 * Intentionally NOT gated by requireWritableTenant — the customer must be able
 * to see their plan + usage even during the grace period so they can
 * decide whether to upgrade.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { getCurrentPlan, getPlanSnapshot } from '../queries/billing.pg.js'
import { createUpgradeRequest } from '../queries/leads.pg.js'
import { chQuery } from '../lib/clickhouse.js'
import { queryRow } from '../lib/postgres.js'
import { createPersonalWorkspaceForUser } from '../queries/tenants.pg.js'
import { generateAccessToken } from '../lib/auth-tokens.js'

type Variables = { tenantId: string; userId: string; role: string }

export const meRouter = new Hono<{ Variables: Variables }>()

meRouter.use('*', jwtAuth)

meRouter.get('/plan', async (c) => {
    const tenantId = c.get('tenantId')
    const snapshot = await getPlanSnapshot(tenantId)
    if (!snapshot) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
    }
    return c.json(snapshot)
})

// POST /v1/me/onboarding/select-trial — user picked Free Trial in the modal.
// Starts the 30-day timer + opens the gate. Idempotent: re-invoking on a
// tenant that already finished onboarding is a no-op (returns the existing
// values without re-arming the timer).
meRouter.post('/onboarding/select-trial', async (c) => {
    let   tenantId = c.get('tenantId')
    const userId   = c.get('userId') as string

    // Trial-abuse guard — a user can only consume one Free Trial across their
    // entire account lifetime, even if they delete the workspace and create a
    // new one. The UI hides the trial card based on the same field; this is
    // the server-side belt to that suspenders.
    const userRow = await queryRow<{ trial_consumed_at: Date | string | null; name: string }>(
        `SELECT trial_consumed_at, name FROM users WHERE user_id = $1`,
        [userId]
    )
    if (userRow?.trial_consumed_at) {
        return c.json({
            error: {
                code:    'TRIAL_ALREADY_CONSUMED',
                message: 'You have already used your one Free Trial. Pick a paid plan to continue.',
            },
        }, 409)
    }

    // Orphan-user branch — user is logged in but has no active workspace
    // (e.g. they deleted their previous solo workspace). Spin up a fresh
    // personal trial workspace for them and issue a new JWT pointing at it.
    let issuedToken: string | null = null
    if (!tenantId) {
        const created = await createPersonalWorkspaceForUser({
            userId,
            userName: userRow?.name || 'workspace',
        })
        // Re-point users.tenant_id at the new tenant so subsequent /me calls work.
        await queryRow(
            `UPDATE users SET tenant_id = $1, role = 'admin', updated_at = now()
             WHERE user_id = $2`,
            [created.tenantId, userId]
        )
        tenantId = created.tenantId
        // Fresh access token with the new tenant claim. Refresh tokens stay
        // valid since they're tied to the user, not the tenant.
        issuedToken = generateAccessToken({ userId, tenantId, role: 'admin' })
    }

    // Idempotency guard — if the gate is already open, just echo current state
    const existing = await queryRow<{ onboarding_completed_at: Date | string | null; trial_ends_at: Date | string | null }>(
        `SELECT onboarding_completed_at, trial_ends_at FROM tenants WHERE tenant_id = $1`,
        [tenantId]
    )
    if (!existing) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    if (existing.onboarding_completed_at) {
        return c.json({ ok: true, alreadyOnboarded: true, accessToken: issuedToken })
    }

    await queryRow(
        `UPDATE tenants
         SET plan_tier               = 'trial',
             trial_ends_at           = now() + INTERVAL '30 days',
             plan_changed_at         = now(),
             onboarding_completed_at = now(),
             updated_at              = now()
         WHERE tenant_id = $1`,
        [tenantId]
    )
    // Stamp the user — one-time trial enforcement survives workspace deletion.
    // COALESCE preserves an earlier consumption timestamp if somehow already set.
    await queryRow(
        `UPDATE users
         SET trial_consumed_at = COALESCE(trial_consumed_at, now()),
             updated_at        = now()
         WHERE user_id = $1`,
        [userId]
    )
    // Orphan path: we minted a fresh token AND moved the user to a new tenant.
    // Return the updated user snapshot so the frontend can patch its auth
    // store and the Sidebar / Workspace switcher immediately see the new
    // tenant context. Non-orphan path returns just { ok: true }.
    if (issuedToken) {
        const updatedUser = await queryRow<{
            user_id: string; tenant_id: string; email: string; name: string
            role: string; status: string; created_at: Date; email_verified_at: Date | null
        }>(
            `SELECT user_id, tenant_id, email, name, role, status, created_at, email_verified_at
             FROM users WHERE user_id = $1`,
            [userId]
        )
        return c.json({
            ok: true,
            accessToken: issuedToken,
            user: updatedUser ? {
                userId:          updatedUser.user_id,
                tenantId:        updatedUser.tenant_id,
                email:           updatedUser.email,
                name:            updatedUser.name,
                role:            updatedUser.role,
                status:          updatedUser.status,
                createdAt:       toIsoIfDate(updatedUser.created_at),
                emailVerifiedAt: updatedUser.email_verified_at ? toIsoIfDate(updatedUser.email_verified_at) : null,
            } : null,
        })
    }
    return c.json({ ok: true })
})

function toIsoIfDate(d: Date | string | null): string {
    if (!d) return ''
    return d instanceof Date ? d.toISOString() : String(d)
}

// POST /v1/me/upgrade-request — pre-Stripe upgrade flow.
// Records the request and lets a superadmin manually fulfill via the dashboard.
const UpgradeRequestSchema = z.object({
    requestedPlanTier: z.enum(['pro', 'team', 'enterprise']),
    billingCycle:      z.enum(['monthly', 'annual']).optional().default('monthly'),
    trigger:           z.enum(['agent_cap', 'event_quota', 'day_28_warning', 'day_31_expired', 'manual']).optional(),
    note:              z.string().max(2000).optional(),
})

// GET /v1/me/usage?days=30 — time-series billed-event counts per day.
// Powers the usage charts on the Billing settings page.
meRouter.get('/usage', async (c) => {
    const tenantId = c.get('tenantId')
    const days     = Math.min(Math.max(Number(c.req.query('days') ?? 30), 1), 365)

    type Row = { day: string; events: number; agent_id: string }
    const rows = await chQuery<Row>(
        `SELECT
            toDate(emitted_at)                                AS day,
            agent_id,
            countIf(event_type IN ('llm_start','llm_end','tool_start','tool_end')) AS events
         FROM obs_events FINAL
         WHERE tenant_id = {tenantId:String}
           AND emitted_at >= now() - INTERVAL {days:UInt32} DAY
         GROUP BY day, agent_id
         ORDER BY day ASC, events DESC`,
        { tenantId, days }
    )

    // Roll up per-day totals + per-agent totals for the UI
    const byDay = new Map<string, number>()
    const byAgent = new Map<string, number>()
    for (const r of rows) {
        byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.events))
        byAgent.set(r.agent_id, (byAgent.get(r.agent_id) ?? 0) + Number(r.events))
    }

    return c.json({
        days,
        daily: [...byDay.entries()].map(([day, events]) => ({ day, events })),
        byAgent: [...byAgent.entries()]
            .map(([agentId, events]) => ({ agentId, events }))
            .sort((a, b) => b.events - a.events)
            .slice(0, 10),
    })
})

meRouter.post('/upgrade-request', async (c) => {
    const tenantId = c.get('tenantId')
    const userId   = c.get('userId')
    let body: unknown
    try { body = await c.req.json() } catch {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400)
    }
    const parsed = UpgradeRequestSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'Validation error' } }, 400)
    }
    const plan = await getCurrentPlan(tenantId)
    if (!plan) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
    }
    const req = await createUpgradeRequest({
        tenantId,
        requestedByUserId: userId,
        currentPlanTier:   plan.planTier,
        requestedPlanTier: parsed.data.requestedPlanTier,
        billingCycle:      parsed.data.billingCycle,
        trigger:           parsed.data.trigger,
        note:              parsed.data.note,
    })
    return c.json({ ok: true, requestId: req.requestId }, 201)
})
