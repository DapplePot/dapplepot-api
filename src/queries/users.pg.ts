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
    trial_consumed_at: Date | string | null
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
        trialConsumedAt: r.trial_consumed_at ? toIso(r.trial_consumed_at) : null,
        passwordHash: r.password_hash,
    }
}

export async function findUserByEmail(
    tenantId: string,
    email: string
): Promise<(UserSummary & { passwordHash: string }) | undefined> {
    const row = await queryRow<UserRow>(
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at, trial_consumed_at
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
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at, trial_consumed_at
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
        `SELECT user_id, tenant_id, email, name, role, status, password_hash, created_at, updated_at, email_verified_at, trial_consumed_at
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

    const rows = await queryRows<UserRow & { is_owner: boolean }>(
        `SELECT u.user_id, m.tenant_id, u.email, u.name, m.role, u.status,
                u.password_hash, u.created_at, u.updated_at, u.email_verified_at,
                (t.owner_user_id = u.user_id) AS is_owner
         FROM tenant_members m
         JOIN users u    ON u.user_id    = m.user_id
         JOIN tenants t  ON t.tenant_id  = m.tenant_id
         ${where}
         ORDER BY (t.owner_user_id = u.user_id) DESC, m.joined_at DESC
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
            return { ...(u as UserSummary), isOwner: r.is_owner ?? false }
        }),
        total: parseInt(countRow?.count ?? '0', 10),
    }
}

export interface UserGrowthPoint {
    month:        string  // 'YYYY-MM'
    total:        number
    self:         number  // personal workspaces / self-signups
    organization: number  // invited or onboarded into an org
}

interface UserGrowthRow extends Record<string, unknown> {
    month:     string
    bucket:    'self' | 'organization'
    new_count: string
}

// Monthly cumulative user counts, split by how the account was created:
// `self` covers self-signup (personal-workspace owners), `organization`
// covers invited or superadmin-onboarded accounts (NULL signup_source —
// pre-personal-tenant data — falls into `organization`).
export async function getUserGrowth(): Promise<UserGrowthPoint[]> {
    const rows = await queryRows<UserGrowthRow>(
        `SELECT
           to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           CASE
             WHEN signup_source = 'self_signup' THEN 'self'
             ELSE 'organization'
           END AS bucket,
           COUNT(*) AS new_count
         FROM users
         GROUP BY 1, 2
         ORDER BY 1`
    )
    if (rows.length === 0) return []

    const newByMonth = new Map<string, { self: number; organization: number }>()
    for (const r of rows) {
        const slot = newByMonth.get(r.month) ?? { self: 0, organization: 0 }
        slot[r.bucket] += parseInt(r.new_count, 10)
        newByMonth.set(r.month, slot)
    }

    const firstMonth = rows[0]!.month
    const now = new Date()
    const lastMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

    const months: string[] = []
    let [y, m] = firstMonth.split('-').map(Number) as [number, number]
    const [yEnd, mEnd] = lastMonth.split('-').map(Number) as [number, number]
    while (y < yEnd || (y === yEnd && m <= mEnd)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`)
        m += 1
        if (m > 12) { m = 1; y += 1 }
    }

    let self = 0
    let org = 0
    return months.map((mo) => {
        const slot = newByMonth.get(mo)
        if (slot) {
            self += slot.self
            org += slot.organization
        }
        return { month: mo, self, organization: org, total: self + org }
    })
}

export interface UserMembership {
    tenantId:   string
    tenantName: string
    role:       'admin' | 'editor' | 'viewer'
}

export interface UserWithMemberships {
    userId:           string
    email:            string
    name:             string
    role:             Role
    status:           Status
    createdAt:        string
    emailVerifiedAt:  string | null
    activeTenantId:   string | null
    activeTenantName: string | null
    memberships:      UserMembership[]
}

interface UserWithMembershipsRow extends Record<string, unknown> {
    user_id:            string
    email:              string
    name:               string
    role:               Role
    status:             Status
    created_at:         Date | string
    email_verified_at:  Date | string | null
    active_tenant_id:   string | null
    active_tenant_name: string | null
    memberships:        UserMembership[]
}

// Superadmin-only system-wide users listing. Each row carries every workspace
// the user is a member of (via tenant_members), plus their currently-active
// workspace pointer for display.
export async function listAllUsers(): Promise<UserWithMemberships[]> {
    const rows = await queryRows<UserWithMembershipsRow>(
        `SELECT
           u.user_id,
           u.email,
           u.name,
           u.role,
           u.status,
           u.created_at,
           u.email_verified_at,
           u.tenant_id AS active_tenant_id,
           at.name     AS active_tenant_name,
           COALESCE(m.memberships, '[]'::json) AS memberships
         FROM users u
         LEFT JOIN tenants at ON at.tenant_id = u.tenant_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
             'tenantId',   tm.tenant_id,
             'tenantName', t.name,
             'role',       tm.role
           ) ORDER BY tm.joined_at ASC) AS memberships
           FROM tenant_members tm
           JOIN tenants t ON t.tenant_id = tm.tenant_id
           WHERE tm.user_id = u.user_id
         ) m ON TRUE
         ORDER BY u.created_at DESC`
    )
    return rows.map((r) => ({
        userId:           r.user_id,
        email:            r.email,
        name:             r.name,
        role:             r.role,
        status:           r.status,
        createdAt:        toIso(r.created_at),
        emailVerifiedAt:  r.email_verified_at ? toIso(r.email_verified_at) : null,
        activeTenantId:   r.active_tenant_id,
        activeTenantName: r.active_tenant_name,
        memberships:      r.memberships ?? [],
    }))
}

// Hard-deletes a user and every reference that would block the delete.
// Personal tenants owned by the user are deleted with their tenant-scoped
// data. Outstanding invites issued by the user, refresh tokens, and password
// reset rows are wiped. tenant_members and email_verifications cascade on
// user delete, so no manual cleanup there.
//
// Returns false if the user didn't exist.
export async function deleteUserById(userId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
        const existing = await tx.unsafe<{ user_id: string }[]>(
            `SELECT user_id FROM users WHERE user_id = $1 LIMIT 1`,
            [userId]
        )
        if (existing.length === 0) return false

        // Owner protection: can't delete a user who owns any active org tenant.
        // They must transfer ownership first (or delete the tenant itself).
        // Personal tenants they own get cleaned up below — those are theirs to
        // remove with their account.
        const ownedOrgs = await tx.unsafe<{ tenant_id: string }[]>(
            `SELECT tenant_id FROM tenants
             WHERE owner_user_id = $1 AND kind = 'organization' AND enabled = true`,
            [userId]
        )
        if (ownedOrgs.length > 0) {
            throw new OwnerRemovalError()
        }

        // Tear down personal tenants this user owns. Mirror deleteTenant()'s
        // approach for the non-cascading child tables.
        const personal = await tx.unsafe<{ tenant_id: string }[]>(
            `SELECT tenant_id FROM tenants WHERE owner_user_id = $1 AND kind = 'personal'`,
            [userId]
        )
        for (const t of personal) {
            await tx.unsafe(`DELETE FROM alerts         WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM invites        WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM sessions       WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM audit_archives WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM tenants        WHERE tenant_id = $1`, [t.tenant_id])
        }

        // FKs without CASCADE that point at users.user_id
        await tx.unsafe(`DELETE FROM invites         WHERE invited_by = $1`, [userId])
        await tx.unsafe(`DELETE FROM password_resets WHERE user_id    = $1`, [userId])
        await tx.unsafe(`DELETE FROM refresh_tokens  WHERE user_id    = $1`, [userId])

        // tenant_members and email_verifications cascade on user delete.
        await tx.unsafe(`DELETE FROM users WHERE user_id = $1`, [userId])
        return true
    })
}

/**
 * Force-delete a user AND every organisation tenant they own. Destructive —
 * intended for superadmin cleanup of test data or hard GDPR-style removals.
 * Returns the list of tenants that were destroyed alongside the user, so the
 * caller can show / audit the blast radius.
 */
export async function forceDeleteUserById(userId: string): Promise<{
    deletedTenants: { tenantId: string; name: string }[]
} | null> {
    return sql.begin(async (tx) => {
        const existing = await tx.unsafe<{ user_id: string }[]>(
            `SELECT user_id FROM users WHERE user_id = $1 LIMIT 1`,
            [userId]
        )
        if (existing.length === 0) return null

        // Collect every tenant this user owns (personal + organization) so we
        // can wipe them all. Personal tenants would have been cleaned up by the
        // regular delete path anyway; orgs are the new behaviour here.
        const owned = await tx.unsafe<{ tenant_id: string; name: string }[]>(
            `SELECT tenant_id, name FROM tenants WHERE owner_user_id = $1`,
            [userId]
        )

        for (const t of owned) {
            // Mirror deleteTenant()'s sequence for non-CASCADE FKs.
            await tx.unsafe(`DELETE FROM alerts         WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM invites        WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM sessions       WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM audit_archives WHERE tenant_id = $1`, [t.tenant_id])
            await tx.unsafe(`DELETE FROM tenants        WHERE tenant_id = $1`, [t.tenant_id])
        }

        // FKs without CASCADE that point at users.user_id
        await tx.unsafe(`DELETE FROM invites         WHERE invited_by = $1`, [userId])
        await tx.unsafe(`DELETE FROM password_resets WHERE user_id    = $1`, [userId])
        await tx.unsafe(`DELETE FROM refresh_tokens  WHERE user_id    = $1`, [userId])

        await tx.unsafe(`DELETE FROM users WHERE user_id = $1`, [userId])

        return {
            deletedTenants: owned.map(t => ({ tenantId: t.tenant_id, name: t.name })),
        }
    })
}

/**
 * Removes a user from a tenant's membership list. Used by Settings → Users →
 * "Remove from workspace". The user account stays intact — they just lose
 * access to this specific workspace. If their active workspace was this one,
 * we re-point users.tenant_id to another tenant they're a member of, or NULL
 * (orphan state) if they have no others.
 *
 * Guards:
 *   - Owner cannot be removed (must transfer ownership first)
 *   - Cannot remove the last admin (forces owner action)
 */
export async function removeUserFromTenant(
    tenantId: string,
    userId: string
): Promise<{ removed: boolean; repointedTo: string | null }> {
    return sql.begin(async (tx) => {
        // Owner guard
        const ownerRows = await tx.unsafe<{ owner_user_id: string | null }[]>(
            `SELECT owner_user_id FROM tenants WHERE tenant_id = $1 LIMIT 1`,
            [tenantId]
        )
        if (ownerRows[0]?.owner_user_id === userId) {
            throw new OwnerRoleChangeError()  // re-use — same semantic protection
        }

        // Last-admin guard: don't strand the workspace
        const memberRows = await tx.unsafe<{ role: Role }[]>(
            `SELECT role FROM tenant_members WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
            [userId, tenantId]
        )
        const member = memberRows[0]
        if (!member) return { removed: false, repointedTo: null }
        if (member.role === 'admin') {
            const adminCountRows = await tx.unsafe<{ count: string }[]>(
                `SELECT COUNT(*)::text AS count FROM tenant_members
                 WHERE tenant_id = $1 AND role = 'admin'`,
                [tenantId]
            )
            const adminCount = parseInt(adminCountRows[0]?.count ?? '0', 10)
            if (adminCount <= 1) throw new LastAdminError()
        }

        // Drop the membership row
        await tx.unsafe(
            `DELETE FROM tenant_members WHERE user_id = $1 AND tenant_id = $2`,
            [userId, tenantId]
        )

        // If this was the user's active workspace, re-point to another (or NULL).
        const userRows = await tx.unsafe<{ tenant_id: string | null }[]>(
            `SELECT tenant_id FROM users WHERE user_id = $1 LIMIT 1`,
            [userId]
        )
        if (userRows[0]?.tenant_id !== tenantId) {
            return { removed: true, repointedTo: userRows[0]?.tenant_id ?? null }
        }
        // Same as deleteTenant's re-point pattern: pick the oldest other membership.
        const otherRows = await tx.unsafe<{ tenant_id: string; role: Role }[]>(
            `SELECT tenant_id, role FROM tenant_members
             WHERE user_id = $1
             ORDER BY joined_at ASC
             LIMIT 1`,
            [userId]
        )
        const other = otherRows[0]
        await tx.unsafe(
            `UPDATE users SET tenant_id = $1, role = $2, updated_at = now()
             WHERE user_id = $3`,
            [other?.tenant_id ?? null, other?.role ?? null, userId]
        )
        return { removed: true, repointedTo: other?.tenant_id ?? null }
    })
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

export class OwnerRoleChangeError extends Error {
    constructor() {
        super('OWNER_ROLE_LOCKED')
        this.name = 'OwnerRoleChangeError'
    }
}

export class OwnerRemovalError extends Error {
    constructor() {
        super('OWNER_REMOVAL_FORBIDDEN')
        this.name = 'OwnerRemovalError'
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

        // Owner protection: the workspace owner cannot be demoted by anyone
        // (including themselves via this path). Owners must transfer ownership
        // first, then delete their account, or contact support. Keeps the
        // "who's responsible for billing" pointer stable.
        const ownerRows = await tx.unsafe<{ owner_user_id: string | null }[]>(
            `SELECT owner_user_id FROM tenants WHERE tenant_id = $1 LIMIT 1`,
            [tenantId]
        )
        if (ownerRows[0]?.owner_user_id === userId && role !== 'admin') {
            throw new OwnerRoleChangeError()
        }

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
