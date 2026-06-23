import { queryRow, queryRows } from '../lib/postgres.js'

type Role = 'admin' | 'editor' | 'viewer'

interface TenantMemberRow extends Record<string, unknown> {
    user_id: string
    tenant_id: string
    role: Role
    joined_at: Date | string
}

interface UserTenantSummaryRow extends Record<string, unknown> {
    tenant_id: string
    name: string
    kind: 'personal' | 'organization'
    role: Role
    joined_at: Date | string
}

export interface UserTenantSummary {
    tenantId: string
    name: string
    kind: 'personal' | 'organization'
    role: Role
    joinedAt: string
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

export async function addTenantMember(params: {
    userId: string
    tenantId: string
    role: Role
}): Promise<void> {
    await queryRow(
        `INSERT INTO tenant_members (user_id, tenant_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
        [params.userId, params.tenantId, params.role]
    )
}

export async function getMembership(
    userId: string,
    tenantId: string
): Promise<{ role: Role } | undefined> {
    const row = await queryRow<TenantMemberRow>(
        `SELECT user_id, tenant_id, role, joined_at
         FROM tenant_members WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [userId, tenantId]
    )
    if (!row) return undefined
    return { role: row.role }
}

export async function listTenantsForUser(userId: string): Promise<UserTenantSummary[]> {
    const rows = await queryRows<UserTenantSummaryRow>(
        `SELECT t.tenant_id, t.name, t.kind, m.role, m.joined_at
         FROM tenant_members m
         JOIN tenants t ON t.tenant_id = m.tenant_id
         WHERE m.user_id = $1
         ORDER BY t.kind = 'personal' DESC, m.joined_at ASC`,
        [userId]
    )
    return rows.map(r => ({
        tenantId: r.tenant_id,
        name: r.name,
        kind: r.kind,
        role: r.role,
        joinedAt: toIso(r.joined_at),
    }))
}

export async function removeTenantMember(userId: string, tenantId: string): Promise<boolean> {
    const row = await queryRow<{ user_id: string }>(
        `DELETE FROM tenant_members WHERE user_id = $1 AND tenant_id = $2 RETURNING user_id`,
        [userId, tenantId]
    )
    return row != null
}
