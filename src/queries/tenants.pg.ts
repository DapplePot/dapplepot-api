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
    owner_user_id: string | null
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

// Trims leading/trailing whitespace and collapses internal whitespace runs
// to a single space — keeps auto-generated tenant names tidy when a user
// accidentally types extra spaces in their name during signup.
function cleanName(name: string): string {
    return name.trim().replace(/\s+/g, ' ')
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
    kind: 'personal' | 'organization'
    plan_tier: 'internal' | 'trial' | 'pro' | 'team' | 'enterprise'
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
    kind: 'personal' | 'organization'
    planTier: 'internal' | 'trial' | 'pro' | 'team' | 'enterprise'
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
    ownerUserId: string | null
    createdAt: string
    updatedAt: string
}

export async function getTenantById(tenantId: string): Promise<TenantItem | null> {
    const row = await queryRows<TenantRow>(
        `SELECT tenant_id, name, kind, enabled, token_budget, rate_limit,
                owner_user_id, created_at, updated_at
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
        ownerUserId: r.owner_user_id,
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
           t.kind,
           t.plan_tier,
           t.token_budget,
           t.rate_limit,
           t.created_at,
           t.updated_at,
           (
             -- Prefer the workspace owner; fall back to any active admin
             -- linked via tenant_members. Joining on users.tenant_id would
             -- miss admins who own multiple workspaces (their users.tenant_id
             -- only points at one of them).
             SELECT json_build_object('name', u.name, 'email', u.email)
             FROM users u
             JOIN tenant_members tm ON tm.user_id = u.user_id
             WHERE tm.tenant_id = t.tenant_id
               AND tm.role      = 'admin'
               AND u.status     = 'active'
             ORDER BY (u.user_id = t.owner_user_id) DESC, tm.joined_at ASC
             LIMIT 1
           ) AS admin_user,
           (
             SELECT COUNT(*) FROM tenant_members tm WHERE tm.tenant_id = t.tenant_id
           ) AS user_count
         FROM tenants t
         ORDER BY t.created_at DESC`
    )
    return rows.map((r) => ({
        tenantId: r.tenant_id,
        name: r.name,
        enabled: r.enabled,
        kind: r.kind,
        planTier: r.plan_tier,
        tokenBudget: r.token_budget,
        rateLimit: r.rate_limit,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
        adminUser: r.admin_user ?? null,
        userCount: parseInt(r.user_count, 10),
    }))
}

// Hard-deletes a tenant and every tenant-scoped row. Used by superadmin only.
//
// Most child tables (sdk_keys, agents, policy_rules, channels, mcp_servers,
// tools, llm_models, tenant_members, …) declare ON DELETE CASCADE, so the
// final DELETE on tenants takes care of them. A handful of tables were
// declared without CASCADE — alerts, invites, sessions, audit_archives — and
// the users table only has a plain FK (since its tenant_id is nullable for
// superadmins). We clean those up explicitly first.
//
// Users get special handling: a single identity (one email) can belong to
// multiple tenants via tenant_members. If a user belonged to *this* tenant
// AND another one, we re-point their primary tenant pointer to that other
// tenant instead of deleting the row. Users whose only home was this tenant
// are deleted.
//
// Returns false if the tenant didn't exist.
export async function deleteTenant(tenantId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
        const existing = await tx.unsafe<{ tenant_id: string }[]>(
            `SELECT tenant_id FROM tenants WHERE tenant_id = $1 LIMIT 1`,
            [tenantId]
        )
        if (existing.length === 0) return false

        // Re-point users who have membership in another tenant.
        await tx.unsafe(
            `UPDATE users u
             SET tenant_id = (
                   SELECT tm.tenant_id
                   FROM tenant_members tm
                   WHERE tm.user_id = u.user_id AND tm.tenant_id <> $1
                   ORDER BY tm.joined_at ASC
                   LIMIT 1
                 ),
                 role = (
                   SELECT tm.role
                   FROM tenant_members tm
                   WHERE tm.user_id = u.user_id AND tm.tenant_id <> $1
                   ORDER BY tm.joined_at ASC
                   LIMIT 1
                 ),
                 updated_at = now()
             WHERE u.tenant_id = $1
               AND EXISTS (
                 SELECT 1 FROM tenant_members tm
                 WHERE tm.user_id = u.user_id AND tm.tenant_id <> $1
               )`,
            [tenantId]
        )

        // Orphan users whose ONLY workspace was this one — keep the account row
        // so they can log back in (the re-point UPDATE above already moved
        // anyone with other memberships to one of those). The user record is
        // preserved with tenant_id=NULL; the existing trial_consumed_at column
        // (set by selectTrialPlan) prevents them from claiming a fresh trial
        // if they create another workspace later.
        await tx.unsafe(
            `UPDATE users
             SET tenant_id  = NULL,
                 updated_at = now()
             WHERE tenant_id = $1`,
            [tenantId]
        )

        // Non-cascading tenant-scoped rows.
        await tx.unsafe(`DELETE FROM alerts         WHERE tenant_id = $1`, [tenantId])
        await tx.unsafe(`DELETE FROM invites        WHERE tenant_id = $1`, [tenantId])
        await tx.unsafe(`DELETE FROM sessions       WHERE tenant_id = $1`, [tenantId])
        await tx.unsafe(`DELETE FROM audit_archives WHERE tenant_id = $1`, [tenantId])

        // The cascades handle everything else.
        await tx.unsafe(`DELETE FROM tenants WHERE tenant_id = $1`, [tenantId])
        return true
    })
}

export interface TenantGrowthPoint {
    month:        string  // 'YYYY-MM'
    total:        number
    organization: number
    personal:     number
}

interface GrowthRow extends Record<string, unknown> {
    month:     string
    kind:      'personal' | 'organization'
    new_count: string  // COUNT() → bigint → string
}

// Returns monthly cumulative tenant counts from the first tenant's month
// through the current month, split by kind. Empty months are filled forward
// so the line chart is continuous.
export async function getTenantGrowth(): Promise<TenantGrowthPoint[]> {
    const rows = await queryRows<GrowthRow>(
        `SELECT
           to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           kind,
           COUNT(*) AS new_count
         FROM tenants
         GROUP BY 1, 2
         ORDER BY 1`
    )
    if (rows.length === 0) return []

    const newByMonth = new Map<string, { organization: number; personal: number }>()
    for (const r of rows) {
        const slot = newByMonth.get(r.month) ?? { organization: 0, personal: 0 }
        slot[r.kind] += parseInt(r.new_count, 10)
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

    let org = 0
    let pers = 0
    return months.map((mo) => {
        const slot = newByMonth.get(mo)
        if (slot) {
            org += slot.organization
            pers += slot.personal
        }
        return { month: mo, organization: org, personal: pers, total: org + pers }
    })
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
    const tenantName = `${cleanName(params.name)}'s workspace`

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

        // 2. Create the personal tenant owned by the user.
        //    plan_tier='trial' is the canonical self-signup tier, but
        //    trial_ends_at and onboarding_completed_at are left NULL — the
        //    trial timer doesn't start until the user picks "Free Trial" in
        //    the plan-selection modal, and the dashboard stays locked until
        //    they make a choice. See db/postgres/048_onboarding_gate.sql.
        const [tenant] = await tx.unsafe<TenantRow[]>(
            `INSERT INTO tenants (name, kind, owner_user_id, plan_tier,
                                  trial_ends_at, onboarding_completed_at)
             VALUES ($1, 'personal', $2, 'trial', NULL, NULL)
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
    const tenantName = `${cleanName(params.userName)}'s workspace`

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
            // plan_tier/trial_ends_at/onboarding_completed_at left to the
            // self-signup convention — see notes above.
            `INSERT INTO tenants (name, kind, owner_user_id, plan_tier,
                                  trial_ends_at, onboarding_completed_at)
             VALUES ($1, 'personal', $2, 'trial', NULL, NULL)
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

// Note: PersonalTenantExistsError was deprecated when Internal-Individual onboarding
// for an existing user now upgrades their existing personal tenant to plan_tier='internal'
// instead of rejecting. Kept here only because routes/tenants.ts still imports it for
// back-compat; the new code path no longer throws it.
export class PersonalTenantExistsError extends Error {
    constructor(public readonly existingTenantName: string) {
        super('PERSONAL_TENANT_EXISTS')
        this.name = 'PersonalTenantExistsError'
    }
}

export async function onboardTenant(params: {
    tenantName: string
    kind: 'personal' | 'organization'
    planTier: 'internal' | 'enterprise'
    tokenBudget: number | null
    rateLimit: number | null
    /** Enterprise-only — contractual seat cap. NULL for non-Enterprise. */
    enterpriseSeatsCap?: number | null
    /** Enterprise-only — contractual monthly event quota. NULL for non-Enterprise. */
    enterpriseEventsPerPeriod?: number | null
    adminEmail: string
    /** New users only — ignored when linking an existing DapplePot user. */
    adminName: string
    /** New users only — ignored when linking an existing DapplePot user. */
    passwordHash: string
}): Promise<OnboardResult & { linkedExistingUser: boolean }> {
    const { rawKey, keyHash, maskedKey } = generateSdkKey()

    // Only honor the enterprise overrides for Enterprise tenants.
    const seatsCap        = params.planTier === 'enterprise' ? (params.enterpriseSeatsCap ?? null)         : null
    const eventsPerPeriod = params.planTier === 'enterprise' ? (params.enterpriseEventsPerPeriod ?? null)  : null

    return sql.begin(async (tx) => {
        // ── Step 0. Look up whether the email already belongs to a DapplePot
        // user. If yes, we link them as admin/owner instead of creating a new
        // user row. Their existing workspaces stay untouched.
        const [existingUser] = await tx.unsafe<{
            user_id: string
            name: string
            email: string
            role: string
        }[]>(
            `SELECT user_id, name, email, role
             FROM users
             WHERE LOWER(email) = LOWER($1)
             ORDER BY created_at ASC
             LIMIT 1`,
            [params.adminEmail]
        )
        const linkedExistingUser = !!existingUser
        if (existingUser?.role === 'superadmin') {
            // Superadmins manage workspaces from /admin, not as tenant members.
            throw new Error('Cannot onboard a tenant for a superadmin account')
        }

        // Internal-Individual + existing user with an existing personal tenant:
        // the partial unique index `tenants(owner_user_id) WHERE kind='personal'`
        // forbids a second personal tenant. Instead of rejecting, upgrade the
        // existing personal tenant to plan_tier='internal' so the comp grant
        // takes effect on the workspace they already use day-to-day. Return
        // early — no new tenant + no new SDK key.
        if (linkedExistingUser && params.kind === 'personal' && params.planTier === 'internal') {
            const [existingPersonal] = await tx.unsafe<TenantRow[]>(
                `SELECT tenant_id, name, enabled, token_budget, rate_limit, created_at, updated_at
                 FROM tenants
                 WHERE owner_user_id = $1 AND kind = 'personal'
                 LIMIT 1`,
                [existingUser!.user_id]
            )
            if (existingPersonal) {
                await tx.unsafe(
                    `UPDATE tenants
                     SET plan_tier               = 'internal',
                         plan_changed_at         = now(),
                         trial_ends_at           = NULL,
                         lifecycle_state         = 'active',
                         lifecycle_changed_at    = now(),
                         enabled                 = true,
                         onboarding_completed_at = COALESCE(onboarding_completed_at, now()),
                         updated_at              = now()
                     WHERE tenant_id = $1`,
                    [existingPersonal.tenant_id]
                )
                // Cancel any active paid subscription they had on this tenant —
                // they're now on a comp account, so we don't want LS to keep billing.
                await tx.unsafe(
                    `UPDATE subscriptions
                     SET status     = 'cancelled',
                         cancel_at  = COALESCE(cancel_at, now()),
                         updated_at = now()
                     WHERE tenant_id = $1 AND status = 'active'`,
                    [existingPersonal.tenant_id]
                )
                return {
                    tenant: {
                        tenantId:    existingPersonal.tenant_id,
                        name:        existingPersonal.name,
                        enabled:     true,
                        tokenBudget: existingPersonal.token_budget,
                        rateLimit:   existingPersonal.rate_limit,
                        createdAt:   toIso(existingPersonal.created_at),
                        updatedAt:   new Date().toISOString(),
                    },
                    admin: {
                        userId:    existingUser!.user_id,
                        email:     existingUser!.email,
                        name:      existingUser!.name,
                        role:      'admin',
                        createdAt: new Date().toISOString(),
                    },
                    sdkKey: '',   // existing tenant already has one; no new key issued
                    linkedExistingUser: true,
                }
            }
            // No existing personal tenant → fall through to the normal create flow below.
        }

        // ── Step 1. Create the tenant ────────────────────────────────────
        // Superadmin-onboarded tenants skip the post-signup OnboardingGate —
        // their plan is already chosen, so onboarding_completed_at is set now.
        //
        // Personal-workspace naming guard: when linking an existing user (so we
        // don't know their name on the wizard form) AND creating a personal
        // workspace, the frontend can't construct "<name>'s workspace" properly.
        // Derive the name server-side from the existing user's `users.name` to
        // avoid landing rows like "'s workspace".
        let tenantNameToUse = params.tenantName
        if (params.kind === 'personal' && linkedExistingUser) {
            const existingName = cleanName(existingUser!.name ?? '')
            if (existingName) {
                tenantNameToUse = `${existingName}'s workspace`
            }
        }

        const [tenant] = await tx.unsafe<TenantRow[]>(
            `INSERT INTO tenants (name, kind, plan_tier, token_budget, rate_limit,
                                  enterprise_seats_cap, enterprise_events_per_period,
                                  plan_changed_at, onboarding_completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
             RETURNING tenant_id, name, enabled, token_budget, rate_limit, created_at, updated_at`,
            [tenantNameToUse, params.kind, params.planTier, params.tokenBudget, params.rateLimit,
             seatsCap, eventsPerPeriod]
        )
        if (!tenant) throw new Error('Failed to create tenant')

        // ── Step 2. Resolve the admin user — either link existing or create. ──
        let adminUserId: string
        let adminEmail:  string
        let adminName:   string

        if (linkedExistingUser) {
            adminUserId = existingUser!.user_id
            adminEmail  = existingUser!.email
            adminName   = existingUser!.name
            // No INSERT into users — they already exist. Keep their existing
            // name / password / preferences intact.
        } else {
            const [admin] = await tx.unsafe<UserRow[]>(
                `INSERT INTO users (tenant_id, email, name, password_hash, role, status, email_verified_at, signup_source)
                 VALUES ($1, $2, $3, $4, 'admin', 'active', now(), 'superadmin_onboard')
                 RETURNING user_id, email, name, role, created_at`,
                [tenant.tenant_id, params.adminEmail, params.adminName, params.passwordHash]
            )
            if (!admin) throw new Error('Failed to create admin user')
            adminUserId = admin.user_id
            adminEmail  = admin.email
            adminName   = admin.name
        }

        await tx.unsafe(
            `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1, $2, 'admin')
             ON CONFLICT (user_id, tenant_id) DO NOTHING`,
            [adminUserId, tenant.tenant_id]
        )

        // Stamp this admin as the workspace owner — they're the natural owner
        // since the superadmin handed them the keys at provision time.
        // Owner protection then prevents them from being demoted or removed
        // by other admins added later (e.g. via Settings → Users invites).
        await tx.unsafe(
            `UPDATE tenants SET owner_user_id = $1, updated_at = now() WHERE tenant_id = $2`,
            [adminUserId, tenant.tenant_id]
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
                userId:    adminUserId,
                email:     adminEmail,
                name:      adminName,
                role:      'admin',
                // For linked existing users we don't have a "createdAt" for
                // this specific tenant membership — use now() as the join time.
                createdAt: new Date().toISOString(),
            },
            sdkKey: rawKey,
            linkedExistingUser,
        }
    })
}
