import { queryRow, queryRows } from '../lib/postgres.js'

interface PasswordResetRow extends Record<string, unknown> {
    reset_id: string
    user_id: string
    token_hash: string
    expires_at: Date | string
    used_at: Date | string | null
    created_at: Date | string
}

export async function createPasswordReset(params: {
    userId: string
    tokenHash: string
    expiresAt: Date
}): Promise<void> {
    // Invalidate any existing unused resets first
    await queryRows(
        `UPDATE password_resets SET used_at = now()
         WHERE user_id = $1 AND used_at IS NULL`,
        [params.userId]
    )
    await queryRow(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [params.userId, params.tokenHash, params.expiresAt.toISOString()]
    )
}

export async function findValidPasswordReset(
    tokenHash: string
): Promise<{ resetId: string; userId: string } | undefined> {
    const row = await queryRow<PasswordResetRow>(
        `SELECT reset_id, user_id, token_hash, expires_at, used_at, created_at
         FROM password_resets
         WHERE token_hash = $1 AND used_at IS NULL
         LIMIT 1`,
        [tokenHash]
    )
    if (!row) return undefined
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
    if (expiresAt < new Date()) return undefined
    return { resetId: row.reset_id, userId: row.user_id }
}

export async function markPasswordResetUsed(resetId: string): Promise<void> {
    await queryRow(
        `UPDATE password_resets SET used_at = now() WHERE reset_id = $1`,
        [resetId]
    )
}
