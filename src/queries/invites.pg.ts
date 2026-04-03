import { queryRow, queryRows } from '../lib/postgres.js'
import type { InviteSummary } from '../types/auth.js'

type Role = 'admin' | 'editor' | 'viewer'
type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

interface InviteRow extends Record<string, unknown> {
    invite_id: string
    tenant_id: string
    email: string
    role: Role
    invited_by: string
    token_hash: string
    status: InviteStatus
    expires_at: Date | string
    accepted_at: Date | string | null
    created_at: Date | string
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

function mapInvite(r: InviteRow): InviteSummary {
    return {
        inviteId: r.invite_id,
        email: r.email,
        role: r.role,
        status: r.status,
        invitedBy: r.invited_by,
        createdAt: toIso(r.created_at),
        expiresAt: toIso(r.expires_at),
    }
}

export async function findPendingInviteByToken(
    tokenHash: string
): Promise<(InviteSummary & { tenantId: string; tokenHash: string }) | undefined> {
    const row = await queryRow<InviteRow>(
        `SELECT invite_id, tenant_id, email, role, invited_by, token_hash, status, expires_at, accepted_at, created_at
         FROM invites
         WHERE token_hash = $1 AND status = 'pending'
         LIMIT 1`,
        [tokenHash]
    )
    if (!row) return undefined
    return { ...mapInvite(row), tenantId: row.tenant_id, tokenHash: row.token_hash }
}

export async function findPendingInviteByEmail(
    tenantId: string,
    email: string
): Promise<InviteSummary | undefined> {
    const row = await queryRow<InviteRow>(
        `SELECT invite_id, tenant_id, email, role, invited_by, token_hash, status, expires_at, accepted_at, created_at
         FROM invites
         WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'
         LIMIT 1`,
        [tenantId, email]
    )
    if (!row) return undefined
    return mapInvite(row)
}

export async function createInvite(params: {
    tenantId: string
    email: string
    role: Role
    invitedBy: string
    tokenHash: string
    expiresAt: Date
}): Promise<InviteSummary> {
    const row = await queryRow<InviteRow>(
        `INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING invite_id, tenant_id, email, role, invited_by, token_hash, status, expires_at, accepted_at, created_at`,
        [
            params.tenantId,
            params.email,
            params.role,
            params.invitedBy,
            params.tokenHash,
            params.expiresAt.toISOString(),
        ]
    )
    if (!row) throw new Error('Failed to create invite')
    return mapInvite(row)
}

export async function listInvites(tenantId: string): Promise<InviteSummary[]> {
    const rows = await queryRows<InviteRow>(
        `SELECT invite_id, tenant_id, email, role, invited_by, token_hash, status, expires_at, accepted_at, created_at
         FROM invites
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId]
    )
    return rows.map(mapInvite)
}

export async function acceptInvite(inviteId: string): Promise<void> {
    await queryRow(
        `UPDATE invites SET status = 'accepted', accepted_at = now() WHERE invite_id = $1`,
        [inviteId]
    )
}

export async function revokeInvite(
    tenantId: string,
    inviteId: string
): Promise<boolean> {
    const row = await queryRow<{ invite_id: string }>(
        `UPDATE invites SET status = 'revoked'
         WHERE invite_id = $1 AND tenant_id = $2 AND status = 'pending'
         RETURNING invite_id`,
        [inviteId, tenantId]
    )
    return !!row
}
