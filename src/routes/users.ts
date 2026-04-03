import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
const { compare, hash: bcryptHash } = bcrypt
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import {
    listUsers,
    findUserById,
    findUserByEmailAnyTenant,
    updateUserRole,
    updateUserStatus,
    updateUserProfile,
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
import { inviteEmail } from '../lib/email/templates.js'
import { hashToken } from '../lib/auth-tokens.js'
import { env } from '../env.js'

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

// GET /v1/users/invites — admin only
usersRouter.get('/invites', requireRole('admin'), async (c) => {
    const tenantId = c.get('tenantId') as string
    const invites = await listInvites(tenantId)
    return c.json({ invites })
})

// POST /v1/users/invite — admin only
usersRouter.post('/invite', requireRole('admin'), async (c) => {
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

    // Check if active user already exists
    const existingUser = await findUserByEmailAnyTenant(email)
    if (existingUser && existingUser.tenantId === tenantId) {
        return c.json({ error: { code: 'EMAIL_EXISTS' } }, 409)
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

    // Get inviter name for email
    const inviter = await findUserById(userId as string)
    const msg = inviteEmail({
        appUrl: env.DAPPLEPOT_APP_URL,
        token: rawToken,
        tenantName: tenantId, // tenant name not stored in API; use ID as fallback
        inviterName: inviter?.name || inviter?.email || 'A team member',
        role,
    })
    await emailProvider.send({ ...msg, to: email })

    return c.json(invite, 201)
})

// DELETE /v1/users/invites/:id — admin only
usersRouter.delete('/invites/:id', requireRole('admin'), async (c) => {
    const tenantId = c.get('tenantId') as string
    const inviteId = c.req.param('id') as string
    const revoked = await revokeInvite(tenantId, inviteId)
    if (!revoked) return c.json({ error: { code: 'NOT_FOUND' } }, 404)
    return c.json({ ok: true })
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

    const updated = await updateUserRole(tenantId, targetUserId, parsed.data.role)
    if (!updated) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    return c.json(updated)
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
