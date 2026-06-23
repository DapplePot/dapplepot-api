import { randomBytes, createHash } from 'crypto'
import { sql, queryRows } from '../lib/postgres.js'

interface TenantRow {
    [key: string]: unknown
    tenant_id: string
    name: string
    kind: 'personal' | 'organization'
    enabled: boolean
    token_budget: number | null
    rate_limit: number | null
    created_at: Date | string
    updated_at: Date | string
}

interface UserRow {
    user_id: string
    email: string
    name: string
    role: string
    created_at: Date | string
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

function generateSdkKey(): { rawKey: string; keyHash: string; maskedKey: string } {
    const rawKey = 'dp_sk_' + randomBytes(16).toString('hex')   // dp_sk_ + 32 hex chars = 38 total
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    const maskedKey = 'dp_sk_' + '•'.repeat(26)
    return { rawKey, keyHash, maskedKey }
}

interface TenantListRow extends Record<string, unknown> {
    tenant_id: string
    name: string
    enabled: boolean
    token_budget: number | null
    rate_limit: number | null
    created_at: Date | string
    updated_at: Date | string
    admin_user: { name: string; email: string } | null
    user_count: string  // COUNT() returns bigint → string in postgres.js
}

export interface TenantListItem {
    tenantId: string
    name: string
    enabled: boolean
    tokenBudget: number | null
    rateLimit: number | null
    createdAt: string
    updatedAt: string
    adminUser: { name: string; email: string } | null
    userCount: number
}

export interface TenantItem {
    tenantId: string
    name: string
    kind: 'personal' | 'organization'
    enabled: boolean
    tokenBudget: number | null
    rateLimit: number | null
    createdAt: string
    updatedAt: string
}

export async function getTenantById(tenantId: string): Promise<TenantItem | null> {
    const row = await queryRows<TenantRow>(
        `SELECT tenant_id, name, kind, enabled, token_budget, rate_limit, created_at, updated_at
         FROM tenants WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
    )
    const r = row[0]
    if (!r) return null
    return {
        tenantId: r.tenant_id,
        name: r.name,
        kind: r.kind,
        enabled: r.enabled,
        tokenBudget: r.token_budget,
        rateLimit: r.rate_limit,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    }
}

export async function listTenants(): Promise<TenantListItem[]> {
    const rows = await queryRows<TenantListRow>(
        `SELECT
           t.tenant_id,
           t.name,
           t.enabled,
           t.token_budget,
           t.rate_limit,
           t.created_at,
           t.updated_at,
           (
             SELECT json_build_object('name', u.name, 'email', u.email)
             FROM users u
             WHERE u.tenant_id = t.tenant_id
               AND u.role = 'admin'
               AND u.status = 'active'
             LIMIT 1
           ) AS admin_user,
           (
             SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.tenant_id
           ) AS user_count
         FROM tenants t
         ORDER BY t.created_at DESC`
    )
    return rows.map((r) => ({
        tenantId: r.tenant_id,
        name: r.name,
        enabled: r.enabled,
        tokenBudget: r.token_budget,
        rateLimit: r.rate_limit,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
        adminUser: r.admin_user ?? null,
        userCount: parseInt(r.user_count, 10),
    }))
}

export interface OnboardResult {
    tenant: {
        tenantId: string
        name: string
        enabled: boolean
        tokenBudget: number | null
        rateLimit: number | null
        createdAt: string
        updatedAt: string
    }
    admin: {
        userId: string
        email: string
        name: string
        role: string
        createdAt: string
    }
    sdkKey: string  // raw key — shown once, never retrievable again
}

export interface SignupIndividualResult {
    user: {
        userId: string
        tenantId: string
        email: string
        name: string
        role: 'admin'
        status: 'active'
        createdAt: string
    }
    tenant: {
        tenantId: string
        name: string
        kind: 'personal'
    }
    sdkKey: string
}

export async function signupIndividual(params: {
    email: string
    name: string
    passwordHash: string
}): Promise<SignupIndividualResult> {
    const { rawKey, keyHash, maskedKey } = generateSdkKey()
    const tenantName = `${params.name}'s workspace`

    return sql.begin(async (tx) => {
        // 1. Create the user first (no tenant yet) — already verified, since
        // this query is only invoked at email-verification time.
        const [user] = await tx.unsafe<UserRow[]>(
            `INSERT INTO users (tenant_id, email, name, password_hash, role, status, signup_source, email_verified_at)
             VALUES (NULL, $1, $2, $3, 'admin', 'active', 'self_signup', now())
             RETURNING user_id, email, name, role, created_at`,
            [params.email, params.name, params.passwordHash]
        )
        if (!user) throw new Error('Failed to create user')

        // 2. Create the personal tenant owned by the user
        const [tenant] = await tx.unsafe<TenantRow[]>(
            `INSERT INTO tenants (name, kind, owner_user_id)
             VALUES ($1, 'personal', $2)
             RETURNING tenant_id, name, enabled, token_budget, rate_limit, created_at, updated_at`,
            [tenantName, user.user_id]
        )
        if (!tenant) throw new Error('Failed to create personal tenant')

        // 3. Link user -> tenant (active workspace pointer)
        await tx.unsafe(
            `UPDATE users SET tenant_id = $1, updated_at = now() WHERE user_id = $2`,
            [tenant.tenant_id, user.user_id]
        )

        // 4. Record the tenant membership (source of truth for "which workspaces does this user have").
        await tx.unsafe(
            `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1, $2, 'admin')`,
            [user.user_id, tenant.tenant_id]
        )

        // 5. Mint default SDK key.
        await tx.unsafe(
            `INSERT INTO sdk_keys (tenant_id, key_hash, masked_key, raw_key, name)
             VALUES ($1, $2, $3, $4, 'default')`,
            [tenant.tenant_id, keyHash, maskedKey, rawKey]
        )

        return {
            user: {
                userId: user.user_id,
                tenantId: tenant.tenant_id,
                email: user.email,
                name: user.name,
                role: 'admin',
                status: 'active',
                createdAt: toIso(user.created_at),
            },
            tenant: {
                tenantId: tenant.tenant_id,
                name: tenant.name,
                kind: 'personal',
            },
            sdkKey: rawKey,
        }
    })
}

export interface CreatePersonalWorkspaceResult {
    tenantId: string
    name: string
    sdkKey: string
}

// Creates a personal workspace for an existing user (e.g. someone who was
// invited into an org first and now wants their own space). Differs from
// signupIndividual: the user already exists, so we don't create a users row.
export async function createPersonalWorkspaceForUser(params: {
    userId: string
    userName: string
}): Promise<CreatePersonalWorkspaceResult> {
    const { rawKey, keyHash, maskedKey } = generateSdkKey()
    const tenantName = `${params.userName}'s workspace`

    return sql.begin(async (tx) => {
        // Guard: one personal tenant per user. The partial unique index on
        // tenants enforces this at the DB level too, but checking up-front
        // gives a friendlier error path.
        const [existing] = await tx.unsafe<{ tenant_id: string }[]>(
            `SELECT tenant_id FROM tenants
             WHERE owner_user_id = $1 AND kind = 'personal' LIMIT 1`,
            [params.userId]
        )
        if (existing) {
            throw new Error('PERSONAL_TENANT_EXISTS')
        }

        const [tenant] = await tx.unsafe<TenantRow[]>(
            `INSERT INTO tenants (name, kind, owner_user_id)
             VALUES ($1, 'personal', $2)
             RETURNING tenant_id, name, enabled, token_budget, rate_limit, created_at, updated_at`,
            [tenantName, params.userId]
        )
        if (!tenant) throw new Error('Failed to create personal tenant')

        await tx.unsafe(
            `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1, $2, 'admin')`,
            [params.userId, tenant.tenant_id]
        )

        await tx.unsafe(
            `INSERT INTO sdk_keys (tenant_id, key_hash, masked_key, raw_key, name)
             VALUES ($1, $2, $3, $4, 'default')`,
            [tenant.tenant_id, keyHash, maskedKey, rawKey]
        )

        return {
            tenantId: tenant.tenant_id,
            name: tenant.name,
            sdkKey: rawKey,
        }
    })
}

export async function onboardTenant(params: {
    tenantName: string
    tokenBudget: number | null
    rateLimit: number | null
    adminEmail: string
    adminName: string
    passwordHash: string
}): Promise<OnboardResult> {
    const { rawKey, keyHash, maskedKey } = generateSdkKey()

    return sql.begin(async (tx) => {
        const [tenant] = await tx.unsafe<TenantRow[]>(
            `INSERT INTO tenants (name, token_budget, rate_limit)
             VALUES ($1, $2, $3)
             RETURNING tenant_id, name, enabled, token_budget, rate_limit, created_at, updated_at`,
            [params.tenantName, params.tokenBudget, params.rateLimit]
        )
        if (!tenant) throw new Error('Failed to create tenant')

        const [admin] = await tx.unsafe<UserRow[]>(
            `INSERT INTO users (tenant_id, email, name, password_hash, role, status, email_verified_at, signup_source)
             VALUES ($1, $2, $3, $4, 'admin', 'active', now(), 'superadmin_onboard')
             RETURNING user_id, email, name, role, created_at`,
            [tenant.tenant_id, params.adminEmail, params.adminName, params.passwordHash]
        )
        if (!admin) throw new Error('Failed to create admin user')

        await tx.unsafe(
            `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1, $2, 'admin')`,
            [admin.user_id, tenant.tenant_id]
        )

        await tx.unsafe(
            `INSERT INTO sdk_keys (tenant_id, key_hash, masked_key, raw_key, name)
             VALUES ($1, $2, $3, $4, 'default')`,
            [tenant.tenant_id, keyHash, maskedKey, rawKey]
        )

        return {
            tenant: {
                tenantId: tenant.tenant_id,
                name: tenant.name,
                enabled: tenant.enabled,
                tokenBudget: tenant.token_budget,
                rateLimit: tenant.rate_limit,
                createdAt: toIso(tenant.created_at),
                updatedAt: toIso(tenant.updated_at),
            },
            admin: {
                userId: admin.user_id,
                email: admin.email,
                name: admin.name,
                role: admin.role,
                createdAt: toIso(admin.created_at),
            },
            sdkKey: rawKey,
        }
    })
}
