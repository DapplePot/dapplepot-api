import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
const { compare, hash: bcryptHash } = bcrypt
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole, requireOrganizationTenant } from '../middleware/authorize.js'
import {
    listUsers,
    listAllUsers,
    getUserGrowth,
    findUserById,
    findUserByEmailAnyTenant,
    updateUserRole,
    updateUserStatus,
    updateUserProfile,
    deleteUserById,
    forceDeleteUserById,
    removeUserFromTenant,
    LastAdminError,
    OwnerRoleChangeError,
    OwnerRemovalError,
} from '../queries/users.pg.js'
import {
    createInvite,
    listInvites,
    revokeInvite,
    findPendingInviteByEmail,
} from '../queries/invites.pg.js'
import {
    revokeAllRefreshTokensForUser,
} from '../queries/refresh-tokens.pg.js'
import { emailProvider } from '../lib/email/index.js'
import { getTenantById } from '../queries/tenants.pg.js'
import { inviteEmail } from '../lib/email/templates.js'
import { hashToken } from '../lib/auth-tokens.js'
import { env } from '../env.js'
import { listTenantsForUser, getMembership } from '../queries/tenant-members.pg.js'

type Variables = { tenantId: string; userId: string; role: string }

export const usersRouter = new Hono<{ Variables: Variables }>()

// All user routes require JWT auth
usersRouter.use('*', jwtAuth)

// GET /v1/users — admin only
usersRouter.get('/', requireRole('admin'), async (c) => {
    const tenantId = c.get('tenantId') as string
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)))
    const statusFilter = c.req.query('status') as 'active' | 'disabled' | undefined

    const { users, total } = await listUsers(tenantId, page, limit, statusFilter)
    return c.json({
        data: users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
})

// GET /v1/users/all — superadmin only. System-wide users list with
// every workspace membership attached.
usersRouter.get('/all', requireRole('superadmin'), async (c) => {
    const users = await listAllUsers()
    return c.json(users)
})

// GET /v1/users/stats/growth — superadmin only. Monthly cumulative user
// counts split by signup_source.
usersRouter.get('/stats/growth', requireRole('superadmin'), async (c) => {
    const points = await getUserGrowth()
    return c.json(points)
})

// GET /v1/users/me/tenants — workspaces this user is a member of
usersRouter.get('/me/tenants', async (c) => {
    const userId = c.get('userId') as string
    const tenants = await listTenantsForUser(userId)
    return c.json({ tenants })
})

// GET /v1/users/me — any authenticated user
usersRouter.get('/me', async (c) => {
    const userId = c.get('userId') as string
    const user = await findUserById(userId)
    if (!user) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    const { passwordHash: _, ...safeUser } = user
    return c.json(safeUser)
})

// PUT /v1/users/me — any authenticated user
usersRouter.put('/me', async (c) => {
    const userId = c.get('userId') as string
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        name: z.string().min(1).max(200).optional(),
        currentPassword: z.string().optional(),
        newPassword: z.string().min(8).max(128).optional(),
    }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
    }

    const { name, currentPassword, newPassword } = parsed.data
    const user = await findUserById(userId)
    if (!user) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    let newPasswordHash: string | undefined

    if (currentPassword !== undefined || newPassword !== undefined) {
        if (!currentPassword || !newPassword) {
            return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Both currentPassword and newPassword are required' } }, 400)
        }
        const valid = await compare(currentPassword, user.passwordHash!)
        if (!valid) {
            return c.json({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect' } }, 400)
        }
        newPasswordHash = await bcryptHash(newPassword, 12)
    }

    const profileUpdate: { name?: string; passwordHash?: string } = {}
    if (name !== undefined) profileUpdate.name = name
    if (newPasswordHash !== undefined) profileUpdate.passwordHash = newPasswordHash
    const updated = await updateUserProfile(userId, profileUpdate)
    if (!updated) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    if (newPasswordHash) {
        // Revoke all refresh tokens — access token still valid for its remaining lifetime
        await revokeAllRefreshTokensForUser(userId)
    }

    return c.json(updated)
})

// GET /v1/users/invites — admin only, organization tenants only
usersRouter.get('/invites', requireRole('admin'), requireOrganizationTenant(), async (c) => {
    const tenantId = c.get('tenantId') as string
    const invites = await listInvites(tenantId)
    return c.json({ invites })
})

// POST /v1/users/invite — admin only, organization tenants only
usersRouter.post('/invite', requireRole('admin'), requireOrganizationTenant(), async (c) => {
    const tenantId = c.get('tenantId') as string
    const userId = c.get('userId') as string
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        email: z.string().email(),
        role: z.enum(['admin', 'editor', 'viewer']),
    }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
    }

    const { email, role } = parsed.data

    // Reject if the email already maps to a user who is a member of this
    // tenant — regardless of which workspace they're currently looking at.
    const existingUser = await findUserByEmailAnyTenant(email)
    if (existingUser) {
        const membership = await getMembership(existingUser.userId, tenantId)
        if (membership) {
            return c.json({ error: { code: 'EMAIL_EXISTS' } }, 409)
        }
    }

    // Check if pending invite already exists
    const existingInvite = await findPendingInviteByEmail(tenantId, email)
    if (existingInvite) {
        return c.json({ error: { code: 'INVITE_PENDING' } }, 409)
    }

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const invite = await createInvite({ tenantId, email, role, invitedBy: userId as string, tokenHash, expiresAt })

    // Resolve inviter + workspace names for the email body.
    const [inviter, tenant] = await Promise.all([
        findUserById(userId as string),
        getTenantById(tenantId),
    ])
    const msg = inviteEmail({
        appUrl: env.DAPPLEPOT_APP_URL,
        token: rawToken,
        tenantName:  tenant?.name  ?? 'a DapplePot workspace',
        inviterName: inviter?.name || inviter?.email || 'A team member',
        role,
    })
    await emailProvider.send({ ...msg, to: email })

    return c.json(invite, 201)
})

// DELETE /v1/users/invites/:id — admin only, organization tenants only
usersRouter.delete('/invites/:id', requireRole('admin'), requireOrganizationTenant(), async (c) => {
    const tenantId = c.get('tenantId') as string
    const inviteId = c.req.param('id') as string
    const revoked = await revokeInvite(tenantId, inviteId)
    if (!revoked) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    return c.json({ ok: true })
})

// DELETE /v1/users/:id — superadmin only. Hard-deletes the user, their
// personal workspace(s), and every tenant_members / refresh_token / etc.
// row that ties back to them.
usersRouter.delete('/:id', requireRole('superadmin'), async (c) => {
    const requestingUserId = c.get('userId') as string
    const targetUserId     = c.req.param('id') as string

    if (targetUserId === requestingUserId) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot delete your own account' } }, 400)
    }

    const target = await findUserById(targetUserId)
    if (!target) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    if (target.role === 'superadmin') {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Superadmin accounts cannot be deleted' } }, 403)
    }

    try {
        const ok = await deleteUserById(targetUserId)
        if (!ok) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        return c.body(null, 204)
    } catch (err) {
        if (err instanceof OwnerRemovalError) {
            return c.json(
                { error: { code: 'OWNER_REMOVAL_FORBIDDEN', message: 'This user owns one or more organisation workspaces. Transfer ownership or use force-delete.' } },
                409
            )
        }
        const msg = err instanceof Error ? err.message : 'Internal server error'
        return c.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
    }
})

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/users/:id/force-delete — superadmin only.
// Destructive: deletes the user AND every tenant they own (personal + org),
// cascading through tenant-scoped data. Use for hard cleanup of test accounts
// or GDPR-style removals where the owner pointer would otherwise block the
// normal DELETE. Caller must send { acknowledged: true } in the body to
// confirm they understand the blast radius.
// ────────────────────────────────────────────────────────────────────────────
usersRouter.post('/:id/force-delete', requireRole('superadmin'), async (c) => {
    const requestingUserId = c.get('userId') as string
    const targetUserId     = c.req.param('id') as string

    if (targetUserId === requestingUserId) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot force-delete your own account' } }, 400)
    }

    const target = await findUserById(targetUserId)
    if (!target) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    if (target.role === 'superadmin') {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Superadmin accounts cannot be force-deleted' } }, 403)
    }

    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ acknowledged: z.literal(true) }).safeParse(body)
    if (!parsed.success) {
        return c.json({
            error: {
                code:    'CONFIRMATION_REQUIRED',
                message: 'Force-delete requires { "acknowledged": true } to confirm the operation.',
            },
        }, 400)
    }

    try {
        const result = await forceDeleteUserById(targetUserId)
        if (!result) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        return c.json(result, 200)
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Internal server error'
        return c.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
    }
})

// PUT /v1/users/:id/role — admin only
usersRouter.put('/:id/role', requireRole('admin'), async (c) => {
    const tenantId = c.get('tenantId') as string
    const requestingUserId = c.get('userId') as string
    const targetUserId = c.req.param('id') as string

    if (targetUserId === requestingUserId) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot change your own role' } }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ role: z.enum(['admin', 'editor', 'viewer']) }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
    }

    try {
        const updated = await updateUserRole(tenantId, targetUserId, parsed.data.role)
        if (!updated) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        return c.json(updated)
    } catch (err) {
        if (err instanceof LastAdminError) {
            return c.json(
                { error: { code: 'LAST_ADMIN', message: 'Cannot demote the only remaining admin. Promote another user to admin first.' } },
                409
            )
        }
        if (err instanceof OwnerRoleChangeError) {
            return c.json(
                { error: { code: 'OWNER_ROLE_LOCKED', message: 'The workspace owner must remain an admin. Transfer ownership first to demote this user.' } },
                409
            )
        }
        throw err
    }
})

// PUT /v1/users/:id/status — admin only
usersRouter.put('/:id/status', requireRole('admin'), async (c) => {
    const tenantId = c.get('tenantId') as string
    const requestingUserId = c.get('userId') as string
    const targetUserId = c.req.param('id') as string

    if (targetUserId === requestingUserId) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot change your own status' } }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ status: z.enum(['active', 'disabled']) }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
    }

    const updated = await updateUserStatus(tenantId, targetUserId, parsed.data.status)
    if (!updated) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    if (parsed.data.status === 'disabled') {
        await revokeAllRefreshTokensForUser(targetUserId)
    }

    return c.json(updated)
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/users/:id/membership — admin only.
// Removes a user from THIS tenant's membership list. The user account stays
// intact (other workspaces they belong to are unaffected). Used by Settings
// → Users → "Remove from workspace". This is the non-destructive counterpart
// to the superadmin DELETE /:id (which wipes the user globally).
// ─────────────────────────────────────────────────────────────────────────────
usersRouter.delete('/:id/membership', requireRole('admin'), requireOrganizationTenant(), async (c) => {
    const tenantId         = c.get('tenantId')         as string
    const requestingUserId = c.get('userId')           as string
    const targetUserId     = c.req.param('id')         as string

    if (targetUserId === requestingUserId) {
        return c.json({
            error: { code: 'FORBIDDEN', message: 'Cannot remove yourself from this workspace.' },
        }, 400)
    }

    try {
        const result = await removeUserFromTenant(tenantId, targetUserId)
        if (!result.removed) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
        // Force them to re-login (their JWT may still reference this tenant).
        await revokeAllRefreshTokensForUser(targetUserId)
        return c.json(result, 200)
    } catch (err) {
        if (err instanceof OwnerRoleChangeError) {
            return c.json({
                error: { code: 'OWNER_ROLE_LOCKED', message: 'The workspace owner cannot be removed. Transfer ownership first.' },
            }, 409)
        }
        if (err instanceof LastAdminError) {
            return c.json({
                error: { code: 'LAST_ADMIN', message: 'Cannot remove the only remaining admin. Promote another user to admin first.' },
            }, 409)
        }
        throw err
    }
})
