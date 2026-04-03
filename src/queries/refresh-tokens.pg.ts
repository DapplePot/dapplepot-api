import { queryRow, queryRows } from '../lib/postgres.js'

interface RefreshTokenRow extends Record<string, unknown> {
    token_id: string
    user_id: string
    token_hash: string
    expires_at: Date | string
    revoked_at: Date | string | null
    created_at: Date | string
}

export async function createRefreshToken(params: {
    userId: string
    tokenHash: string
    expiresAt: Date
}): Promise<void> {
    await queryRow(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [params.userId, params.tokenHash, params.expiresAt.toISOString()]
    )
}

export async function findActiveRefreshToken(
    tokenHash: string
): Promise<{ tokenId: string; userId: string; expiresAt: string } | undefined> {
    const row = await queryRow<RefreshTokenRow>(
        `SELECT token_id, user_id, token_hash, expires_at, revoked_at, created_at
         FROM refresh_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL
         LIMIT 1`,
        [tokenHash]
    )
    if (!row) return undefined
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
    if (expiresAt < new Date()) return undefined
    return {
        tokenId: row.token_id,
        userId: row.user_id,
        expiresAt: expiresAt.toISOString(),
    }
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
    await queryRow(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
        [tokenHash]
    )
}

export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await queryRows(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    )
}

export async function revokeOtherRefreshTokensForUser(
    userId: string,
    keepTokenHash: string
): Promise<void> {
    await queryRows(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND token_hash != $2 AND revoked_at IS NULL`,
        [userId, keepTokenHash]
    )
}
