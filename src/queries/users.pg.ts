import { queryRow, queryRows } from '../lib/postgres.js'
import type { UserSummary } from '../types/auth.js'

type Role = 'superadmin' | 'admin' | 'editor' | 'viewer'
type Status = 'active' | 'disabled'

interface UserRow extends Record<string, unknown> {
    user_id: string
    tenant_id: string | null
    email: string
    name: string
    role: Role
    status: Status
    password_hash: string
    created_at: Date | string
    updated_at: Date | string
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

function mapUser(r: UserRow): UserSummary & { passwordHash?: string } {
    return {
        userId: r.user_id,
        tenantId: r.tenant_id ?? null,
        email: r.email,
        name: r.name,
        role: r.role,
        status: r.status,
        createdAt: toIso(r.created_at),
        passwordHash: r.password_hash,
    }
}

export async function findUserByEmail(
    tenantId: string,
    email: string
): Promise<(UserSummary & { passwordHash: string }) | undefined> {
    const row = await queryRow<UserRow>(
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at
         FROM users
         WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)
         LIMIT 1`,
        [tenantId, email]
    )
    if (!row) return undefined
    return mapUser(row) as UserSummary & { passwordHash: string }
}

export async function findUserByEmailAnyTenant(
    email: string
): Promise<(UserSummary & { passwordHash: string }) | undefined> {
    const row = await queryRow<UserRow>(
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at
         FROM users
         WHERE LOWER(email) = LOWER($1)
         LIMIT 1`,
        [email]
    )
    if (!row) return undefined
    return mapUser(row) as UserSummary & { passwordHash: string }
}

export async function findUserById(userId: string): Promise<(UserSummary & { passwordHash: string }) | undefined> {
    const row = await queryRow<UserRow>(
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at
         FROM users WHERE user_id = $1`,
        [userId]
    )
    if (!row) return undefined
    return mapUser(row) as UserSummary & { passwordHash: string }
}

export async function listUsers(
    tenantId: string,
    page: number,
    limit: number,
    status?: Status
): Promise<{ users: UserSummary[]; total: number }> {
    const offset = (page - 1) * limit
    const params: unknown[] = [tenantId, limit, offset]
    let where = 'WHERE tenant_id = $1'
    if (status) {
        where += ` AND status = $${params.length + 1}`
        params.push(status)
    }

    const rows = await queryRows<UserRow>(
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at
         FROM users ${where}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        params
    )

    const countParams: unknown[] = [tenantId]
    let countWhere = 'WHERE tenant_id = $1'
    if (status) {
        countWhere += ` AND status = $2`
        countParams.push(status)
    }
    const countRow = await queryRow<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users ${countWhere}`,
        countParams
    )

    return {
        users: rows.map((r) => {
            const u = mapUser(r)
            delete u.passwordHash
            return u as UserSummary
        }),
        total: parseInt(countRow?.count ?? '0', 10),
    }
}

export async function createUser(params: {
    tenantId: string
    email: string
    name: string
    passwordHash: string
    role: Role
}): Promise<UserSummary> {
    const row = await queryRow<UserRow>(
        `INSERT INTO users (tenant_id, email, name, password_hash, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at`,
        [params.tenantId, params.email, params.name, params.passwordHash, params.role]
    )
    if (!row) throw new Error('Failed to create user')
    const u = mapUser(row)
    delete u.passwordHash
    return u as UserSummary
}

export async function updateUserRole(
    tenantId: string,
    userId: string,
    role: Role
): Promise<UserSummary | undefined> {
    const row = await queryRow<UserRow>(
        `UPDATE users SET role = $3, updated_at = now()
         WHERE user_id = $1 AND tenant_id = $2
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at`,
        [userId, tenantId, role]
    )
    if (!row) return undefined
    const u = mapUser(row)
    delete u.passwordHash
    return u as UserSummary
}

export async function updateUserStatus(
    tenantId: string,
    userId: string,
    status: Status
): Promise<UserSummary | undefined> {
    const row = await queryRow<UserRow>(
        `UPDATE users SET status = $3, updated_at = now()
         WHERE user_id = $1 AND tenant_id = $2
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at`,
        [userId, tenantId, status]
    )
    if (!row) return undefined
    const u = mapUser(row)
    delete u.passwordHash
    return u as UserSummary
}

export async function updateUserProfile(
    userId: string,
    params: { name?: string; passwordHash?: string }
): Promise<UserSummary | undefined> {
    const row = await queryRow<UserRow>(
        `UPDATE users
         SET name          = COALESCE($2, name),
             password_hash = COALESCE($3, password_hash),
             updated_at    = now()
         WHERE user_id = $1
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at`,
        [userId, params.name ?? null, params.passwordHash ?? null]
    )
    if (!row) return undefined
    const u = mapUser(row)
    delete u.passwordHash
    return u as UserSummary
}
