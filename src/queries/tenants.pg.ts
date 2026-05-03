import { randomBytes, createHash } from 'crypto'
import { sql, queryRows } from '../lib/postgres.js'

interface TenantRow {
    [key: string]: unknown
    tenant_id: string
    name: string
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
    enabled: boolean
    tokenBudget: number | null
    rateLimit: number | null
    createdAt: string
    updatedAt: string
}

export async function getTenantById(tenantId: string): Promise<TenantItem | null> {
    const row = await queryRows<TenantRow>(
        `SELECT tenant_id, name, enabled, token_budget, rate_limit, created_at, updated_at
         FROM tenants WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
    )
    const r = row[0]
    if (!r) return null
    return {
        tenantId: r.tenant_id,
        name: r.name,
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
            `INSERT INTO users (tenant_id, email, name, password_hash, role, status)
             VALUES ($1, $2, $3, $4, 'admin', 'active')
             RETURNING user_id, email, name, role, created_at`,
            [tenant.tenant_id, params.adminEmail, params.adminName, params.passwordHash]
        )
        if (!admin) throw new Error('Failed to create admin user')

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
