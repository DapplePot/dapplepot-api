import { queryRow, queryRows } from '../lib/postgres.js'

interface PendingSignupRow extends Record<string, unknown> {
    signup_id: string
    email: string
    name: string
    password_hash: string
    token_hash: string
    expires_at: Date | string
    used_at: Date | string | null
    created_at: Date | string
}

export interface PendingSignup {
    signupId: string
    email: string
    name: string
    passwordHash: string
}

function expired(row: PendingSignupRow): boolean {
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
    return exp < new Date()
}

export async function createPendingSignup(params: {
    email: string
    name: string
    passwordHash: string
    tokenHash: string
    expiresAt: Date
}): Promise<void> {
    // Invalidate any prior unused signups for this email so only the newest
    // token works (e.g. user hit resend, or restarted signup).
    await queryRows(
        `UPDATE pending_signups SET used_at = now()
         WHERE LOWER(email) = LOWER($1) AND used_at IS NULL`,
        [params.email]
    )
    await queryRow(
        `INSERT INTO pending_signups (email, name, password_hash, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [params.email, params.name, params.passwordHash, params.tokenHash, params.expiresAt.toISOString()]
    )
}

export async function findValidPendingSignupByToken(
    tokenHash: string
): Promise<PendingSignup | undefined> {
    const row = await queryRow<PendingSignupRow>(
        `SELECT signup_id, email, name, password_hash, token_hash, expires_at, used_at, created_at
         FROM pending_signups
         WHERE token_hash = $1 AND used_at IS NULL
         LIMIT 1`,
        [tokenHash]
    )
    if (!row || expired(row)) return undefined
    return {
        signupId: row.signup_id,
        email: row.email,
        name: row.name,
        passwordHash: row.password_hash,
    }
}

export async function findActivePendingSignupByEmail(
    email: string
): Promise<PendingSignup | undefined> {
    const row = await queryRow<PendingSignupRow>(
        `SELECT signup_id, email, name, password_hash, token_hash, expires_at, used_at, created_at
         FROM pending_signups
         WHERE LOWER(email) = LOWER($1) AND used_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [email]
    )
    if (!row || expired(row)) return undefined
    return {
        signupId: row.signup_id,
        email: row.email,
        name: row.name,
        passwordHash: row.password_hash,
    }
}

export async function markPendingSignupUsed(signupId: string): Promise<void> {
    await queryRow(
        `UPDATE pending_signups SET used_at = now() WHERE signup_id = $1`,
        [signupId]
    )
}
