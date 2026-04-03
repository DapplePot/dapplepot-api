import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
const { compare, hash: bcryptHash } = bcrypt
import { randomBytes } from 'crypto'
import { z } from 'zod'
import {
    generateAccessToken,
    generateRefreshToken,
    hashToken,
    ACCESS_EXPIRES_IN_SECONDS,
} from '../lib/auth-tokens.js'
import { emailProvider } from '../lib/email/index.js'
import { inviteEmail, resetEmail } from '../lib/email/templates.js'
import { findUserByEmailAnyTenant, findUserById } from '../queries/users.pg.js'
import { createRefreshToken, findActiveRefreshToken, revokeRefreshToken } from '../queries/refresh-tokens.pg.js'
import { createPasswordReset, findValidPasswordReset } from '../queries/password-resets.pg.js'
import { findPendingInviteByToken } from '../queries/invites.pg.js'
import { redis } from '../lib/redis.js'
import { env } from '../env.js'
import type { LoginResponse } from '../types/auth.js'

export const authRouter = new Hono()

// Dummy hash used for timing-safe login when user not found
const DUMMY_HASH = '$2a$12$LCY0MefVIEc3lEMFE5RFWef1nGsOJhqF/dj7jFJMnNRKjCt7CqAhW'

async function isRateLimited(key: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now()
    const windowStart = now - windowMs
    const pipe = redis.pipeline()
    pipe.zremrangebyscore(key, '-inf', windowStart)
    pipe.zadd(key, now, `${now}-${Math.random()}`)
    pipe.zcard(key)
    pipe.pexpire(key, windowMs)
    const results = await pipe.exec()
    const count = (results?.[2]?.[1] as number) ?? 0
    return count > max
}

function buildLoginResponse(
    user: { userId: string; tenantId: string; email: string; name: string; role: 'admin' | 'editor' | 'viewer'; status: 'active' | 'disabled'; createdAt: string },
    accessToken: string,
    refreshToken: string
): LoginResponse {
    return {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_EXPIRES_IN_SECONDS,
        user: {
            userId: user.userId,
            tenantId: user.tenantId,
            email: user.email,
            name: user.name,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt,
        },
    }
}

// POST /v1/auth/login
authRouter.post('/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ email: z.string(), password: z.string() }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401)
    }
    const { email, password } = parsed.data

    // Rate limit: 10 attempts per email per 15 minutes
    const rlKey = `dp:rl:auth:login:${email.toLowerCase()}`
    if (await isRateLimited(rlKey, 10, 15 * 60 * 1000)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }, 429)
    }

    const user = await findUserByEmailAnyTenant(email)

    // Always run bcrypt to prevent timing-based enumeration
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH
    const valid = await compare(password, hashToCompare)

    if (!user || !valid || user.status !== 'active') {
        return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401)
    }

    const accessToken = generateAccessToken({ userId: user.userId, tenantId: user.tenantId, role: user.role })
    const { raw: refreshToken, hash: refreshHash } = generateRefreshToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createRefreshToken({ userId: user.userId, tokenHash: refreshHash, expiresAt })

    return c.json(buildLoginResponse(user, accessToken, refreshToken))
})

// POST /v1/auth/refresh
authRouter.post('/refresh', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ refreshToken: z.string() }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_REFRESH_TOKEN' } }, 401)
    }

    const ip = c.req.header('x-forwarded-for') ?? 'unknown'
    const rlKey = `dp:rl:auth:refresh:${ip}`
    if (await isRateLimited(rlKey, 20, 60 * 1000)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }, 429)
    }

    const tokenHash = hashToken(parsed.data.refreshToken)
    const stored = await findActiveRefreshToken(tokenHash)
    if (!stored) {
        return c.json({ error: { code: 'INVALID_REFRESH_TOKEN' } }, 401)
    }

    // Revoke old token
    await revokeRefreshToken(tokenHash)

    const user = await findUserById(stored.userId)
    if (!user || user.status !== 'active') {
        return c.json({ error: { code: 'INVALID_REFRESH_TOKEN' } }, 401)
    }

    const accessToken = generateAccessToken({ userId: user.userId, tenantId: user.tenantId, role: user.role })
    const { raw: newRefreshToken, hash: newRefreshHash } = generateRefreshToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createRefreshToken({ userId: user.userId, tokenHash: newRefreshHash, expiresAt })

    return c.json(buildLoginResponse(user, accessToken, newRefreshToken))
})

// POST /v1/auth/logout
authRouter.post('/logout', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ refreshToken: z.string() }).safeParse(body)
    if (parsed.success) {
        const tokenHash = hashToken(parsed.data.refreshToken)
        await revokeRefreshToken(tokenHash)
    }
    return c.json({ ok: true })
})

// POST /v1/auth/forgot-password
authRouter.post('/forgot-password', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ email: z.string().email() }).safeParse(body)
    if (!parsed.success) {
        return c.json({ ok: true, message: 'If that email exists, a reset link has been sent.' })
    }

    const { email } = parsed.data
    const rlKey = `dp:rl:auth:reset:${email.toLowerCase()}`
    if (await isRateLimited(rlKey, 5, 60 * 60 * 1000)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }, 429)
    }

    const user = await findUserByEmailAnyTenant(email)
    if (user) {
        const rawToken = randomBytes(32).toString('hex')
        const tokenHash = hashToken(rawToken)
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour
        await createPasswordReset({ userId: user.userId, tokenHash, expiresAt })

        const msg = resetEmail({ appUrl: env.DAPPLEPOT_APP_URL, token: rawToken, userName: user.name || user.email })
        await emailProvider.send({ ...msg, to: user.email })
    }

    return c.json({ ok: true, message: 'If that email exists, a reset link has been sent.' })
})

// POST /v1/auth/reset-password
authRouter.post('/reset-password', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        token: z.string(),
        password: z.string().min(8).max(128),
    }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_RESET_TOKEN' } }, 400)
    }

    const tokenHash = hashToken(parsed.data.token)
    const reset = await findValidPasswordReset(tokenHash)
    if (!reset) {
        return c.json({ error: { code: 'INVALID_RESET_TOKEN' } }, 400)
    }

    const newHash = await bcryptHash(parsed.data.password, 12)

    // Transaction: update password, mark reset used, revoke all sessions
    const { sql } = await import('../lib/postgres.js')
    await sql.begin(async (tx) => {
        await tx.unsafe('UPDATE users SET password_hash = $1, updated_at = now() WHERE user_id = $2', [newHash, reset.userId])
        await tx.unsafe('UPDATE password_resets SET used_at = now() WHERE reset_id = $1', [reset.resetId])
        await tx.unsafe('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [reset.userId])
    })

    return c.json({ ok: true })
})

// POST /v1/auth/accept-invite
authRouter.post('/accept-invite', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        token: z.string(),
        name: z.string().min(1).max(200),
        password: z.string().min(8).max(128),
    }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const tokenHash = hashToken(parsed.data.token)
    const invite = await findPendingInviteByToken(tokenHash)
    if (!invite) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    // Check if expired
    if (new Date(invite.expiresAt) < new Date()) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    // Check if email already exists for this tenant
    const existing = await findUserByEmailAnyTenant(invite.email)
    if (existing && existing.tenantId === invite.tenantId) {
        return c.json({ error: { code: 'EMAIL_EXISTS' } }, 409)
    }

    const passwordHash = await bcryptHash(parsed.data.password, 12)

    const { sql } = await import('../lib/postgres.js')
    type NewUser = { userId: string; tenantId: string; email: string; name: string; role: 'admin' | 'editor' | 'viewer'; status: 'active' | 'disabled'; createdAt: string }
    let newUser: NewUser | undefined

    await sql.begin(async (tx) => {
        const rows = await tx.unsafe(
            `INSERT INTO users (tenant_id, email, name, password_hash, role)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING user_id, tenant_id, email, name, role, status, created_at`,
            [invite.tenantId, invite.email, parsed.data.name, passwordHash, invite.role]
        )
        const r = rows[0] as Record<string, unknown>
        newUser = {
            userId: r['user_id'] as string,
            tenantId: r['tenant_id'] as string,
            email: r['email'] as string,
            name: r['name'] as string,
            role: r['role'] as 'admin' | 'editor' | 'viewer',
            status: r['status'] as 'active' | 'disabled',
            createdAt: r['created_at'] instanceof Date ? (r['created_at'] as Date).toISOString() : String(r['created_at']),
        }
        await tx.unsafe(
            `UPDATE invites SET status = 'accepted', accepted_at = now() WHERE invite_id = $1`,
            [invite.inviteId]
        )
    })

    if (!newUser) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const accessToken = generateAccessToken({ userId: newUser.userId, tenantId: newUser.tenantId, role: newUser.role })
    const { raw: refreshToken, hash: refreshHash } = generateRefreshToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createRefreshToken({ userId: newUser.userId, tokenHash: refreshHash, expiresAt })

    return c.json(buildLoginResponse(newUser, accessToken, refreshToken))
})
