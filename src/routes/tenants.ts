import { Hono } from 'hono'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
const { hash: bcryptHash } = bcrypt
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { deleteTenant, getTenantById, getTenantGrowth, listTenants, onboardTenant, PersonalTenantExistsError } from '../queries/tenants.pg.js'
import { queryRow } from '../lib/postgres.js'
import { randomBytes } from 'crypto'
import { hashToken } from '../lib/auth-tokens.js'
import { createPasswordReset } from '../queries/password-resets.pg.js'
import { emailProvider } from '../lib/email/index.js'
import {
    onboardNewUserEmail,
    onboardLinkedExistingUserEmail,
    onboardWorkspaceUpgradedEmail,
} from '../lib/email/templates.js'
import { env } from '../env.js'

export const tenantsRouter = new Hono()

const OnboardSchema = z.object({
    tenant: z.object({
        name: z.string().min(1, 'tenant.name is required'),
        // Account type: only the 3 superadmin-provisionable combinations.
        kind:     z.enum(['personal', 'organization']),
        planTier: z.enum(['internal', 'enterprise']),
        tokenBudget: z.number().int().positive().nullable().optional().default(null),
        rateLimit:   z.number().int().positive().nullable().optional().default(null),
        // Enterprise-only contractual limits — ignored for Internal tenants.
        enterpriseSeatsCap:         z.number().int().positive().nullable().optional().default(null),
        enterpriseEventsPerPeriod:  z.number().int().positive().nullable().optional().default(null),
    }).refine(
        t => `${t.planTier}:${t.kind}` === 'internal:personal'
          || `${t.planTier}:${t.kind}` === 'internal:organization'
          || `${t.planTier}:${t.kind}` === 'enterprise:organization',
        { message: 'Invalid (planTier, kind) — must be Internal/Individual, Internal/Organisation, or Enterprise/Organisation' }
    ),
    admin: z.object({
        email:    z.string().email('admin.email must be a valid email'),
        // name + password become optional when the wizard is linking an existing
        // DapplePot user. Treat empty strings as "not provided" so the FE can
        // safely send '' for existing-user submits without tripping min-length checks.
        name: z.preprocess(
            v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
            z.string().min(1).optional()
        ),
        password: z.preprocess(
            v => (typeof v === 'string' && v === '' ? undefined : v),
            z.string().min(8, 'admin.password must be at least 8 characters').optional()
        ),
    }),
})

// GET /v1/tenants/lookup-user?email=... — superadmin only.
// Powers the wizard's email-blur check. Returns whether the email already
// belongs to a DapplePot user so the form can adapt (hide name+password,
// show "Found existing user" confirmation card, surface personal-tenant
// conflict if Internal-Individual was picked).
tenantsRouter.get('/lookup-user', jwtAuth, requireRole('superadmin'), async (c) => {
    const email = String(c.req.query('email') ?? '').trim()
    if (!email) return c.json({ exists: false })

    const row = await queryRow<{
        user_id: string
        name:    string
        email:   string
        role:    string
        status:  string
        has_personal_tenant: boolean
    }>(
        `SELECT u.user_id, u.name, u.email, u.role, u.status,
                EXISTS (
                    SELECT 1 FROM tenants
                    WHERE owner_user_id = u.user_id AND kind = 'personal'
                ) AS has_personal_tenant
         FROM users u
         WHERE LOWER(u.email) = LOWER($1)
         ORDER BY u.created_at ASC
         LIMIT 1`,
        [email]
    )
    if (!row) return c.json({ exists: false })

    return c.json({
        exists:             true,
        userId:             row.user_id,
        name:               row.name,
        email:              row.email,
        role:               row.role,
        status:             row.status,
        hasPersonalTenant:  row.has_personal_tenant,
    })
})

// GET /v1/tenants/stats/growth — superadmin only.
// Declared before /:id so 'stats' is not interpreted as a tenant id.
tenantsRouter.get('/stats/growth', jwtAuth, requireRole('superadmin'), async (c) => {
    const points = await getTenantGrowth()
    return c.json(points)
})

// GET /v1/tenants/:id — superadmin or the tenant's own users
tenantsRouter.get('/:id', jwtAuth, async (c) => {
    const id = c.req.param('id')
    const role = c.get('role')
    const callerTenantId = c.get('tenantId')

    if (role !== 'superadmin' && callerTenantId !== id) {
        return c.json({ error: 'Forbidden' }, 403)
    }

    const tenant = await getTenantById(id)
    if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
    return c.json(tenant)
})

// GET /v1/tenants — superadmin only
tenantsRouter.get('/', jwtAuth, requireRole('superadmin'), async (c) => {
    const tenants = await listTenants()
    return c.json(tenants)
})

// DELETE /v1/tenants/:id — superadmin only. Hard-deletes the tenant and all
// tenant-scoped data. Superadmins cannot delete their own active tenant (they
// have tenant_id = NULL anyway, so this is mostly a belt-and-suspenders check
// for org admins whose tokens get elevated in tests).
tenantsRouter.delete('/:id', jwtAuth, requireRole('superadmin'), async (c) => {
    const id = c.req.param('id')
    const callerTenantId = c.get('tenantId')
    if (callerTenantId === id) {
        return c.json({ error: 'Cannot delete your own active tenant' }, 400)
    }

    try {
        const ok = await deleteTenant(id)
        if (!ok) return c.json({ error: 'Tenant not found' }, 404)
        return c.body(null, 204)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        return c.json({ error: msg || 'Internal server error' }, 500)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// DELETE /v1/me/tenant — workspace-owner self-serve delete.
//
// Mounted on tenantsRouter (which is itself mounted at /v1/tenants) and
// addressed via the /me alias path. The caller must be:
//   - authenticated (jwtAuth)
//   - the workspace owner (tenants.owner_user_id === caller userId)
//   - typed the workspace name into the confirm body (anti-fumble guard)
//
// Use POST so the body (with the typed confirmation) is uncontroversial across
// proxies / curl etc. (Some HTTP stacks strip bodies from DELETE requests.)
// ────────────────────────────────────────────────────────────────────────────
tenantsRouter.post('/me/delete', jwtAuth, async (c) => {
    const userId   = c.get('userId')   as string
    const tenantId = c.get('tenantId') as string

    const tenant = await getTenantById(tenantId)
    if (!tenant) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    // Only the owner may self-serve delete. Other admins can't — they'd need
    // the owner to do it or the owner to transfer ownership first.
    if (tenant.ownerUserId !== userId) {
        return c.json({
            error: {
                code:    'NOT_WORKSPACE_OWNER',
                message: 'Only the workspace owner can delete the workspace.',
            },
        }, 403)
    }

    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        confirmName: z.string(),
    }).safeParse(body)
    if (!parsed.success || parsed.data.confirmName.trim() !== tenant.name) {
        return c.json({
            error: {
                code:    'CONFIRMATION_MISMATCH',
                message: 'Type the workspace name exactly to confirm.',
            },
        }, 400)
    }

    try {
        const ok = await deleteTenant(tenantId)
        if (!ok) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        return c.json({ deleted: true, tenantId, name: tenant.name }, 200)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        return c.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
    }
})

tenantsRouter.post('/onboard', jwtAuth, requireRole('superadmin'), async (c) => {
    let body: unknown
    try {
        body = await c.req.json()
    } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = OnboardSchema.safeParse(body)
    if (!parsed.success) {
        const first = parsed.error.errors[0]
        return c.json({ error: first?.message ?? 'Validation error' }, 400)
    }

    const { tenant, admin } = parsed.data

    // Pre-flight checks so we can: (a) require name+password only for fresh users,
    // and (b) pick the right confirmation email post-onboard.
    const existing = await queryRow<{ user_id: string; name: string }>(
        `SELECT user_id, name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [admin.email]
    )

    if (!existing) {
        if (!admin.name || !admin.password) {
            return c.json({
                error: { code: 'VALIDATION_ERROR', message: 'admin.name and admin.password are required for a new user' },
            }, 400)
        }
    }

    // Detect the "upgrade existing personal workspace" branch — onboardTenant
    // takes this path when (existing user) + (kind=personal) + (planTier=internal)
    // + (user already has a personal tenant). Used below to pick the email template.
    let upgradedExistingPersonal = false
    if (existing && tenant.kind === 'personal' && tenant.planTier === 'internal') {
        const [personalCheck] = await Promise.all([
            queryRow<{ tenant_id: string }>(
                `SELECT tenant_id FROM tenants WHERE owner_user_id = $1 AND kind = 'personal' LIMIT 1`,
                [existing.user_id]
            ),
        ])
        upgradedExistingPersonal = !!personalCheck
    }

    // Only hash if we actually need it (i.e. creating). Existing user keeps theirs.
    const passwordHash = existing ? '' : await bcryptHash(admin.password!, 12)

    try {
        const result = await onboardTenant({
            tenantName:                tenant.name,
            kind:                      tenant.kind,
            planTier:                  tenant.planTier,
            tokenBudget:               tenant.tokenBudget ?? null,
            rateLimit:                 tenant.rateLimit ?? null,
            enterpriseSeatsCap:        tenant.enterpriseSeatsCap ?? null,
            enterpriseEventsPerPeriod: tenant.enterpriseEventsPerPeriod ?? null,
            adminEmail:                admin.email,
            adminName:                 admin.name ?? '',
            passwordHash,
        })

        // ── Fire the confirmation email (fire-and-forget; failure is logged). ──
        // Three template branches:
        //   1. New user           → onboardNewUserEmail (with password-set link)
        //   2. Upgraded existing  → onboardWorkspaceUpgradedEmail
        //   3. Linked existing    → onboardLinkedExistingUserEmail
        void sendOnboardEmail({
            to:        result.admin.email,
            userName:  result.admin.name || result.admin.email,
            tenantName: result.tenant.name,
            plan:      tenant.planTier === 'internal' ? 'Internal' : 'Enterprise',
            scenario:  !existing
                ? { kind: 'new_user', userId: result.admin.userId }
                : upgradedExistingPersonal
                    ? { kind: 'upgraded_existing' }
                    : { kind: 'linked_existing' },
        }).catch(err => console.error('[onboard] confirmation email failed:', err))

        return c.json(result, 201)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('Cannot onboard a tenant for a superadmin')) {
            return c.json({
                error: { code: 'SUPERADMIN_CANNOT_BE_TENANT_ADMIN', message: msg },
            }, 409)
        }
        if (msg.includes('23505') || msg.includes('unique') || msg.toLowerCase().includes('duplicate')) {
            return c.json({ error: 'Conflict creating tenant' }, 409)
        }
        return c.json({ error: 'Internal server error' }, 500)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// Onboard confirmation email — dispatches the right template + sends it.
// Fire-and-forget; called from POST /tenants/onboard after a successful
// transaction commit. Failure is logged but does not surface to the caller
// (the tenant + admin already exist, we just couldn't notify them).
// ────────────────────────────────────────────────────────────────────────────
async function sendOnboardEmail(params: {
    to:         string
    userName:   string
    tenantName: string
    plan:       'Internal' | 'Enterprise'
    scenario:   { kind: 'new_user'; userId: string }
              | { kind: 'linked_existing' }
              | { kind: 'upgraded_existing' }
}): Promise<void> {
    let msg
    if (params.scenario.kind === 'new_user') {
        // Mint a 1-hour password-set token. Safer than sharing the raw password
        // the superadmin typed — they can hand off "check your inbox" instead.
        const rawToken  = randomBytes(32).toString('hex')
        const tokenHash = hashToken(rawToken)
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
        await createPasswordReset({ userId: params.scenario.userId, tokenHash, expiresAt })
        msg = onboardNewUserEmail({
            appUrl:     env.DAPPLEPOT_APP_URL,
            resetToken: rawToken,
            userName:   params.userName,
            userEmail:  params.to,
            tenantName: params.tenantName,
            plan:       params.plan,
        })
    } else if (params.scenario.kind === 'upgraded_existing') {
        msg = onboardWorkspaceUpgradedEmail({
            appUrl:     env.DAPPLEPOT_APP_URL,
            userName:   params.userName,
            tenantName: params.tenantName,
        })
    } else {
        msg = onboardLinkedExistingUserEmail({
            appUrl:     env.DAPPLEPOT_APP_URL,
            userName:   params.userName,
            tenantName: params.tenantName,
            plan:       params.plan,
        })
    }
    await emailProvider.send({ ...msg, to: params.to })
}
