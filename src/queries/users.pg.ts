import { queryRow, queryRows, sql } from '../lib/postgres.js'
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
    email_verified_at: Date | string | null
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
        emailVerifiedAt: r.email_verified_at ? toIso(r.email_verified_at) : null,
        passwordHash: r.password_hash,
    }
}

export async function findUserByEmail(
    tenantId: string,
    email: string
): Promise<(UserSummary & { passwordHash: string }) | undefined> {
    const row = await queryRow<UserRow>(
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at
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
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at
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
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at
         FROM users WHERE user_id = $1`,
        [userId]
    )
    if (!row) return undefined
    return mapUser(row) as UserSummary & { passwordHash: string }
}

// Lists every member of a tenant via tenant_members. The returned `role`
// is the user's role in *this* tenant (m.role), and the returned `tenantId`
// is this tenant — not the user's currently-active workspace.
export async function listUsers(
    tenantId: string,
    page: number,
    limit: number,
    status?: Status
): Promise<{ users: UserSummary[]; total: number }> {
    const offset = (page - 1) * limit
    const params: unknown[] = [tenantId, limit, offset]
    let where = 'WHERE m.tenant_id = $1'
    if (status) {
        where += ` AND u.status = $${params.length + 1}`
        params.push(status)
    }

    const rows = await queryRows<UserRow>(
        `SELECT u.user_id, m.tenant_id, u.email, u.name, m.role, u.status,
                u.password_hash, u.created_at, u.updated_at, u.email_verified_at
         FROM tenant_members m
         JOIN users u ON u.user_id = m.user_id
         ${where}
         ORDER BY m.joined_at DESC
         LIMIT $2 OFFSET $3`,
        params
    )

    const countParams: unknown[] = [tenantId]
    let countWhere = 'WHERE m.tenant_id = $1'
    if (status) {
        countWhere += ` AND u.status = $2`
        countParams.push(status)
    }
    const countRow = await queryRow<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM tenant_members m
         JOIN users u ON u.user_id = m.user_id
         ${countWhere}`,
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
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at`,
        [params.tenantId, params.email, params.name, params.passwordHash, params.role]
    )
    if (!row) throw new Error('Failed to create user')
    const u = mapUser(row)
    delete u.passwordHash
    return u as UserSummary
}

// Thrown when a role change would leave a tenant with zero admins.
export class LastAdminError extends Error {
    constructor() {
        super('LAST_ADMIN')
        this.name = 'LastAdminError'
    }
}

// Changes the target user's role inside this tenant. Also syncs users.role
// when the target's *active* workspace is this same tenant, so the next JWT
// they get carries the new role. If they're currently looking at another
// workspace, users.role is left alone — the new tenant_members.role takes
// effect when they next switch into this tenant.
//
// Refuses to demote the last admin: every tenant must always have at least
// one admin so it can never be left without anyone who can manage it.
export async function updateUserRole(
    tenantId: string,
    userId: string,
    role: Role
): Promise<UserSummary | undefined> {
    return sql.begin(async (tx) => {
        // Check the existing membership first.
        const currentRows = await tx.unsafe<{ role: Role }[]>(
            `SELECT role FROM tenant_members WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
            [userId, tenantId]
        )
        const current = currentRows[0]
        if (!current) return undefined

        // If we're demoting an admin, make sure they aren't the last one.
        if (current.role === 'admin' && role !== 'admin') {
            const adminCountRows = await tx.unsafe<{ count: string }[]>(
                `SELECT COUNT(*)::text AS count FROM tenant_members
                 WHERE tenant_id = $1 AND role = 'admin'`,
                [tenantId]
            )
            const adminCount = parseInt(adminCountRows[0]?.count ?? '0', 10)
            if (adminCount <= 1) {
                throw new LastAdminError()
            }
        }

        await tx.unsafe(
            `UPDATE tenant_members SET role = $3
             WHERE user_id = $1 AND tenant_id = $2`,
            [userId, tenantId, role]
        )

        // Sync users.role only when their active workspace matches.
        await tx.unsafe(
            `UPDATE users SET role = $3, updated_at = now()
             WHERE user_id = $1 AND tenant_id = $2`,
            [userId, tenantId, role]
        )

        const userRows = await tx.unsafe<UserRow[]>(
            `SELECT u.user_id, $2::uuid AS tenant_id, u.email, u.name,
                    $3::text AS role, u.status, u.password_hash,
                    u.created_at, u.updated_at, u.email_verified_at
             FROM users u WHERE u.user_id = $1 LIMIT 1`,
            [userId, tenantId, role]
        )
        const row = userRows[0]
        if (!row) return undefined
        const u = mapUser(row)
        delete u.passwordHash
        return u as UserSummary
    })
}

export async function updateUserStatus(
    tenantId: string,
    userId: string,
    status: Status
): Promise<UserSummary | undefined> {
    const row = await queryRow<UserRow>(
        `UPDATE users SET status = $3, updated_at = now()
         WHERE user_id = $1 AND tenant_id = $2
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at`,
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
         RETURNING user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at`,
        [userId, params.name ?? null, params.passwordHash ?? null]
    )
    if (!row) return undefined
    const u = mapUser(row)
    delete u.passwordHash
    return u as UserSummary
}
