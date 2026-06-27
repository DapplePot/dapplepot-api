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
import { inviteEmail, resetEmail, verifyEmailEmail } from '../lib/email/templates.js'
import { findUserByEmailAnyTenant, findUserById } from '../queries/users.pg.js'
import { createRefreshToken, findActiveRefreshToken, revokeRefreshToken } from '../queries/refresh-tokens.pg.js'
import { createPasswordReset, findValidPasswordReset } from '../queries/password-resets.pg.js'
import {
    createPendingSignup,
    findValidPendingSignupByToken,
    findActivePendingSignupByEmail,
    markPendingSignupUsed,
} from '../queries/pending-signups.pg.js'
import { findPendingInviteByToken } from '../queries/invites.pg.js'
import { signupIndividual, createPersonalWorkspaceForUser } from '../queries/tenants.pg.js'
import { getMembership } from '../queries/tenant-members.pg.js'
import { jwtAuth } from '../middleware/auth.js'
import { redis } from '../lib/redis.js'
import { env } from '../env.js'
import type { LoginResponse } from '../types/auth.js'

export const authRouter = new Hono()

// Dummy hash used for timing-safe login when user not found
const DUMMY_HASH = '$2a$12$LCY0MefVIEc3lEMFE5RFWef1nGsOJhqF/dj7jFJMnNRKjCt7CqAhW'

// Dev/QA escape hatch — `DISABLE_AUTH_RATE_LIMIT=1` in .env makes every
// rate-limit check return false. Useful while iterating on auth flows.
// Re-enable for production by removing the var or setting it to anything
// other than '1' / 'true'.
const RATE_LIMIT_DISABLED =
    process.env.DISABLE_AUTH_RATE_LIMIT === '1' ||
    process.env.DISABLE_AUTH_RATE_LIMIT === 'true'

async function isRateLimited(key: string, max: number, windowMs: number): Promise<boolean> {
    if (RATE_LIMIT_DISABLED) return false
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
    user: {
        userId: string
        tenantId: string | null
        email: string
        name: string
        role: 'superadmin' | 'admin' | 'editor' | 'viewer'
        status: 'active' | 'disabled'
        createdAt: string
        emailVerifiedAt?: string | null
    },
    accessToken: string,
    refreshToken: string
): LoginResponse {
    return {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_EXPIRES_IN_SECONDS,
        user: {
            userId: user.userId,
            // Preserve null for orphan users (no active workspace) — the FE
            // OnboardingGate checks for falsy tenantId to detect orphans.
            // Coercing to '' would defeat that check.
            tenantId: user.tenantId ?? null,
            email: user.email,
            name: user.name,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt,
            emailVerifiedAt: user.emailVerifiedAt ?? null,
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

// POST /v1/auth/signup — stage an individual-developer signup.
// No user, tenant, or SDK key is created here; everything is materialized in
// /verify-email once the email is confirmed.
authRouter.post('/signup', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        email: z.string().email(),
        password: z.string().min(8).max(128),
        name: z.string().min(1).max(200),
    }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' } }, 400)
    }
    const { email, password, name } = parsed.data

    // Rate limit by email and IP — 5 signups per email per day, 20 per IP per hour
    const ip = c.req.header('x-forwarded-for') ?? 'unknown'
    if (await isRateLimited(`dp:rl:auth:signup:e:${email.toLowerCase()}`, 5, 24 * 60 * 60 * 1000)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }, 429)
    }
    if (await isRateLimited(`dp:rl:auth:signup:ip:${ip}`, 20, 60 * 60 * 1000)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }, 429)
    }

    // Reject if a real account already exists with this email
    const existing = await findUserByEmailAnyTenant(email)
    if (existing) {
        return c.json({ error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists' } }, 409)
    }

    const passwordHash = await bcryptHash(password, 12)
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

    try {
        await createPendingSignup({ email, name, passwordHash, tokenHash, expiresAt })
    } catch (err: unknown) {
        console.error('[auth] failed to stage signup:', err)
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Signup failed' } }, 500)
    }

    const msg = verifyEmailEmail({ appUrl: env.DAPPLEPOT_APP_URL, token: rawToken, userName: name })
    await emailProvider.send({ ...msg, to: email }).catch(err =>
        console.error('[auth] failed to send verification email:', err)
    )

    return c.json({ ok: true, message: 'Check your email to finish creating your account.' }, 202)
})

// POST /v1/auth/verify-email — materializes the user, personal tenant, and
// default SDK key from a pending signup, then issues login tokens.
authRouter.post('/verify-email', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ token: z.string() }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_VERIFICATION_TOKEN' } }, 400)
    }

    const tokenHash = hashToken(parsed.data.token)
    const pending = await findValidPendingSignupByToken(tokenHash)
    if (!pending) {
        return c.json({ error: { code: 'INVALID_VERIFICATION_TOKEN' } }, 400)
    }

    // Race protection: someone may have already signed up with this email
    // through a different pending row that finished first.
    const existing = await findUserByEmailAnyTenant(pending.email)
    if (existing) {
        await markPendingSignupUsed(pending.signupId)
        return c.json({ error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists' } }, 409)
    }

    let result
    try {
        result = await signupIndividual({
            email: pending.email,
            name: pending.name,
            passwordHash: pending.passwordHash,
        })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('23505') || msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('unique')) {
            await markPendingSignupUsed(pending.signupId)
            return c.json({ error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists' } }, 409)
        }
        console.error('[auth] verification materialize failed:', err)
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Verification failed' } }, 500)
    }

    await markPendingSignupUsed(pending.signupId)

    // Issue session tokens — user is verified and active, drop them into the app.
    const accessToken = generateAccessToken({
        userId: result.user.userId,
        tenantId: result.user.tenantId,
        role: result.user.role,
    })
    const { raw: refreshToken, hash: refreshHash } = generateRefreshToken()
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createRefreshToken({ userId: result.user.userId, tokenHash: refreshHash, expiresAt: refreshExpiresAt })

    return c.json(
        buildLoginResponse(
            { ...result.user, emailVerifiedAt: new Date().toISOString() },
            accessToken,
            refreshToken
        )
    )
})

// POST /v1/auth/resend-verification — re-issues a token for an active
// pending signup. Silent for emails that don't have one (no enumeration).
authRouter.post('/resend-verification', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ email: z.string().email() }).safeParse(body)
    if (!parsed.success) {
        return c.json({ ok: true })
    }

    const { email } = parsed.data
    const rlKey = `dp:rl:auth:verify-resend:${email.toLowerCase()}`
    if (await isRateLimited(rlKey, 5, 60 * 60 * 1000)) {
        return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }, 429)
    }

    const pending = await findActivePendingSignupByEmail(email)
    if (pending) {
        const rawToken = randomBytes(32).toString('hex')
        const tokenHash = hashToken(rawToken)
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
        // Re-stages with a fresh token (also invalidates the old pending row).
        await createPendingSignup({
            email: pending.email,
            name: pending.name,
            passwordHash: pending.passwordHash,
            tokenHash,
            expiresAt,
        })
        const msg = verifyEmailEmail({ appUrl: env.DAPPLEPOT_APP_URL, token: rawToken, userName: pending.name })
        await emailProvider.send({ ...msg, to: pending.email }).catch(err =>
            console.error('[auth] failed to resend verification email:', err)
        )
    }

    return c.json({ ok: true })
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
        await emailProvider.send({ ...msg, to: user.email }).catch(err =>
            console.error('[auth] failed to send reset email:', err)
        )
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

// POST /v1/auth/create-personal-workspace — creates a personal workspace for
// the caller (if they don't already have one) and switches them into it.
// Used by people who joined an org first (via invite) and now want their own
// space.
authRouter.post('/create-personal-workspace', jwtAuth, async (c) => {
    const userId = c.get('userId') as string
    const user = await findUserById(userId)
    if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED' } }, 401)
    }

    let result
    try {
        result = await createPersonalWorkspaceForUser({
            userId: user.userId,
            userName: user.name || user.email.split('@')[0]!,
        })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('PERSONAL_TENANT_EXISTS') || msg.includes('uq_tenants_personal_owner')) {
            return c.json({ error: { code: 'PERSONAL_TENANT_EXISTS', message: 'You already have a personal workspace' } }, 409)
        }
        console.error('[auth] create personal workspace failed:', err)
        return c.json({ error: { code: 'INTERNAL_ERROR' } }, 500)
    }

    const { sql } = await import('../lib/postgres.js')
    await sql.unsafe(
        `UPDATE users SET tenant_id = $1, role = 'admin', updated_at = now() WHERE user_id = $2`,
        [result.tenantId, userId]
    )
    await sql.unsafe(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    )

    const accessToken = generateAccessToken({ userId, tenantId: result.tenantId, role: 'admin' })
    const { raw: refreshToken, hash: refreshHash } = generateRefreshToken()
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createRefreshToken({ userId, tokenHash: refreshHash, expiresAt: refreshExpiresAt })

    return c.json(buildLoginResponse({ ...user, tenantId: result.tenantId, role: 'admin' }, accessToken, refreshToken))
})

// POST /v1/auth/switch-tenant — switches the active workspace for the caller,
// re-issuing access + refresh tokens scoped to the requested tenant.
authRouter.post('/switch-tenant', jwtAuth, async (c) => {
    const userId = c.get('userId') as string
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ tenantId: z.string().uuid() }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400)
    }
    const targetTenantId = parsed.data.tenantId

    const membership = await getMembership(userId, targetTenantId)
    if (!membership) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' } }, 403)
    }

    const { sql } = await import('../lib/postgres.js')
    await sql.unsafe(
        `UPDATE users SET tenant_id = $1, role = $2, updated_at = now() WHERE user_id = $3`,
        [targetTenantId, membership.role, userId]
    )

    const user = await findUserById(userId)
    if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED' } }, 401)
    }

    const accessToken = generateAccessToken({ userId, tenantId: targetTenantId, role: membership.role })
    const { raw: refreshToken, hash: refreshHash } = generateRefreshToken()
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    // Revoke previous refresh tokens so the old workspace can't be silently resumed.
    await sql.unsafe(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    )
    await createRefreshToken({ userId, tokenHash: refreshHash, expiresAt: refreshExpiresAt })

    return c.json(buildLoginResponse({ ...user, tenantId: targetTenantId, role: membership.role }, accessToken, refreshToken))
})

// GET /v1/auth/invite-info?token=… — unauthenticated. Returns just enough to
// drive the UI: the tenant name + role being offered, the invitee email, and
// whether DapplePot already has an account for that email. The invite token
// itself authenticates this call (32-byte random, single-use, expiring).
authRouter.get('/invite-info', async (c) => {
    const rawToken = c.req.query('token')
    if (!rawToken) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const tokenHash = hashToken(rawToken)
    const invite = await findPendingInviteByToken(tokenHash)
    if (!invite || new Date(invite.expiresAt) < new Date()) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const tenantRow = await (await import('../lib/postgres.js')).queryRow<{ name: string }>(
        'SELECT name FROM tenants WHERE tenant_id = $1 LIMIT 1',
        [invite.tenantId]
    )
    const existing = await findUserByEmailAnyTenant(invite.email)

    return c.json({
        email: invite.email,
        role: invite.role,
        tenantName: tenantRow?.name ?? null,
        accountExists: !!existing,
    })
})

// POST /v1/auth/accept-invite
// If the invitee email already has a global account, we add the tenant
// membership and switch the user's active workspace to the inviting tenant.
// Otherwise we create a fresh account. Either way the response logs the
// user in to the inviting tenant.
authRouter.post('/accept-invite', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({
        token: z.string(),
        // name/password are only used when creating a new account. If the user
        // already exists globally they are ignored.
        name: z.string().min(1).max(200).optional(),
        password: z.string().min(8).max(128).optional(),
    }).safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const tokenHash = hashToken(parsed.data.token)
    const invite = await findPendingInviteByToken(tokenHash)
    if (!invite) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    if (new Date(invite.expiresAt) < new Date()) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const existing = await findUserByEmailAnyTenant(invite.email)

    // Already a member of this exact tenant — nothing to accept.
    if (existing) {
        const { getMembership } = await import('../queries/tenant-members.pg.js')
        const existingMembership = await getMembership(existing.userId, invite.tenantId)
        if (existingMembership) {
            return c.json({ error: { code: 'ALREADY_MEMBER', message: 'You already belong to this workspace' } }, 409)
        }
    }

    // For brand-new accounts both name and password are required.
    if (!existing && (!parsed.data.name || !parsed.data.password)) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and password required to create account' } }, 400)
    }

    const { sql } = await import('../lib/postgres.js')
    type ResultUser = {
        userId: string
        tenantId: string | null
        email: string
        name: string
        role: 'superadmin' | 'admin' | 'editor' | 'viewer'
        status: 'active' | 'disabled'
        createdAt: string
        emailVerifiedAt: string | null
    }
    let resultUser: ResultUser | undefined

    if (existing) {
        await sql.begin(async (tx) => {
            await tx.unsafe(
                `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, tenant_id) DO NOTHING`,
                [existing.userId, invite.tenantId, invite.role]
            )
            // Snap the existing user's active workspace + cached role over to the
            // tenant they just joined, so the next request hits the right place.
            await tx.unsafe(
                `UPDATE users SET tenant_id = $1, role = $2, updated_at = now() WHERE user_id = $3`,
                [invite.tenantId, invite.role, existing.userId]
            )
            await tx.unsafe(
                `UPDATE invites SET status = 'accepted', accepted_at = now() WHERE invite_id = $1`,
                [invite.inviteId]
            )
        })
        resultUser = {
            userId: existing.userId,
            tenantId: invite.tenantId,
            email: existing.email,
            name: existing.name,
            role: invite.role,
            status: existing.status,
            createdAt: existing.createdAt,
            emailVerifiedAt: existing.emailVerifiedAt ?? new Date().toISOString(),
        }
    } else {
        const passwordHash = await bcryptHash(parsed.data.password!, 12)
        await sql.begin(async (tx) => {
            const rows = await tx.unsafe(
                `INSERT INTO users (tenant_id, email, name, password_hash, role, email_verified_at, signup_source)
                 VALUES ($1, $2, $3, $4, $5, now(), 'invite')
                 RETURNING user_id, tenant_id, email, name, role, status, created_at, email_verified_at`,
                [invite.tenantId, invite.email, parsed.data.name!, passwordHash, invite.role]
            )
            const r = rows[0] as Record<string, unknown>
            const verifiedRaw = r['email_verified_at']
            const userId = r['user_id'] as string
            await tx.unsafe(
                `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1, $2, $3)`,
                [userId, invite.tenantId, invite.role]
            )
            resultUser = {
                userId,
                tenantId: r['tenant_id'] as string,
                email: r['email'] as string,
                name: r['name'] as string,
                role: r['role'] as 'admin' | 'editor' | 'viewer',
                status: r['status'] as 'active' | 'disabled',
                createdAt: r['created_at'] instanceof Date ? (r['created_at'] as Date).toISOString() : String(r['created_at']),
                emailVerifiedAt: verifiedRaw instanceof Date ? verifiedRaw.toISOString() : (verifiedRaw ? String(verifiedRaw) : null),
            }
            await tx.unsafe(
                `UPDATE invites SET status = 'accepted', accepted_at = now() WHERE invite_id = $1`,
                [invite.inviteId]
            )
        })
    }

    if (!resultUser) {
        return c.json({ error: { code: 'INVALID_INVITE_TOKEN' } }, 400)
    }

    const accessToken = generateAccessToken({ userId: resultUser.userId, tenantId: resultUser.tenantId, role: resultUser.role })
    const { raw: refreshToken, hash: refreshHash } = generateRefreshToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await createRefreshToken({ userId: resultUser.userId, tokenHash: refreshHash, expiresAt })

    return c.json(buildLoginResponse(resultUser, accessToken, refreshToken))
})
