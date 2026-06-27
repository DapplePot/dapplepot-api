/**
 * Superadmin-only queries: tenant management, user lookup, usage stats,
 * audit log access. All write operations append to admin_audit_log
 * with a before/after JSONB snapshot.
 *
 * Read-side helpers for individual tenants/users are reused from
 * billing.pg.ts and the existing tenants/users query modules — this
 * file only adds the cross-tenant operational surface that doesn't
 * belong on a customer-facing route.
 */

import { queryRow, queryRows, queryValue } from '../lib/postgres.js'
import type { PlanTier } from '../lib/planLimits.js'

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

export type AdminAction =
    | 'tenant.create'
    | 'tenant.change_plan'
    | 'tenant.override_quota'
    | 'tenant.suspend'
    | 'tenant.restore'
    | 'tenant.delete'
    | 'user.reset_password'
    | 'user.change_role'
    | 'subscription.create'
    | 'subscription.update'
    | 'subscription.cancel'

export interface AuditLogEntry {
    logId:        string
    actorUserId:  string
    actorEmail:   string | null
    action:       AdminAction
    targetType:   'tenant' | 'user' | 'subscription'
    targetId:     string | null
    beforeValue:  Record<string, unknown> | null
    afterValue:   Record<string, unknown> | null
    note:         string | null
    createdAt:    string
}

interface AuditLogRow {
    log_id:        string
    actor_user_id: string
    actor_email:   string | null
    action:        AdminAction
    target_type:   'tenant' | 'user' | 'subscription'
    target_id:     string | null
    before_value:  Record<string, unknown> | null
    after_value:   Record<string, unknown> | null
    note:          string | null
    created_at:    Date | string
    [k: string]: unknown
}

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

function mapAudit(r: AuditLogRow): AuditLogEntry {
    return {
        logId:       r.log_id,
        actorUserId: r.actor_user_id,
        actorEmail:  r.actor_email,
        action:      r.action,
        targetType:  r.target_type,
        targetId:    r.target_id,
        beforeValue: r.before_value,
        afterValue:  r.after_value,
        note:        r.note,
        createdAt:   toIso(r.created_at),
    }
}

/**
 * Insert an audit-log row. Called from inside every admin write helper —
 * not exported for direct route use. The actor and target are mandatory;
 * before/after are optional but strongly recommended for any mutation.
 */
async function logAdminAction(params: {
    actorUserId: string
    action:      AdminAction
    targetType:  'tenant' | 'user' | 'subscription'
    targetId:    string | null
    beforeValue: Record<string, unknown> | null
    afterValue:  Record<string, unknown> | null
    note?:       string | null
}): Promise<void> {
    await queryRow(
        `INSERT INTO admin_audit_log
            (actor_user_id, action, target_type, target_id,
             before_value, after_value, note)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [
            params.actorUserId,
            params.action,
            params.targetType,
            params.targetId,
            params.beforeValue ? JSON.stringify(params.beforeValue) : null,
            params.afterValue  ? JSON.stringify(params.afterValue)  : null,
            params.note ?? null,
        ]
    )
}

export interface AuditLogFilter {
    actorUserId?: string
    targetType?:  'tenant' | 'user' | 'subscription'
    targetId?:    string
    action?:      AdminAction
    limit?:       number
    offset?:      number
}

export async function listAuditLog(filter: AuditLogFilter = {}): Promise<AuditLogEntry[]> {
    const conditions: string[] = []
    const params: unknown[]    = []
    let   i                    = 1

    if (filter.actorUserId) { conditions.push(`l.actor_user_id = $${i++}`); params.push(filter.actorUserId) }
    if (filter.targetType)  { conditions.push(`l.target_type   = $${i++}`); params.push(filter.targetType) }
    if (filter.targetId)    { conditions.push(`l.target_id     = $${i++}`); params.push(filter.targetId) }
    if (filter.action)      { conditions.push(`l.action        = $${i++}`); params.push(filter.action) }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit  = Math.min(filter.limit ?? 100, 500)
    const offset = filter.offset ?? 0

    const rows = await queryRows<AuditLogRow>(
        `SELECT l.log_id, l.actor_user_id, u.email AS actor_email, l.action,
                l.target_type, l.target_id, l.before_value, l.after_value,
                l.note, l.created_at
         FROM admin_audit_log l
         LEFT JOIN users u ON u.user_id = l.actor_user_id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
    )
    return rows.map(mapAudit)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant management
// ─────────────────────────────────────────────────────────────────────────────

interface TenantDetailRow {
    tenant_id:       string
    name:            string
    kind:            'personal' | 'organization'
    enabled:         boolean
    plan_tier:       PlanTier
    trial_ends_at:   Date | string | null
    plan_changed_at: Date | string
    owner_user_id:   string | null
    created_at:      Date | string
    updated_at:      Date | string
    [k: string]: unknown
}

export interface TenantDetail {
    tenantId:      string
    name:          string
    kind:          'personal' | 'organization'
    enabled:       boolean
    planTier:      PlanTier
    trialEndsAt:   string | null
    planChangedAt: string
    ownerUserId:   string | null
    createdAt:     string
    updatedAt:     string
}

function mapTenantDetail(r: TenantDetailRow): TenantDetail {
    return {
        tenantId:      r.tenant_id,
        name:          r.name,
        kind:          r.kind,
        enabled:       r.enabled,
        planTier:      r.plan_tier,
        trialEndsAt:   r.trial_ends_at ? toIso(r.trial_ends_at) : null,
        planChangedAt: toIso(r.plan_changed_at),
        ownerUserId:   r.owner_user_id,
        createdAt:     toIso(r.created_at),
        updatedAt:     toIso(r.updated_at),
    }
}

export async function adminGetTenant(tenantId: string): Promise<TenantDetail | null> {
    const row = await queryRow<TenantDetailRow>(
        `SELECT tenant_id, name, kind, enabled, plan_tier, trial_ends_at,
                plan_changed_at, owner_user_id, created_at, updated_at
         FROM tenants
         WHERE tenant_id = $1`,
        [tenantId]
    )
    return row ? mapTenantDetail(row) : null
}

/** Create a new tenant — used to provision Internal + Enterprise accounts.
 *  Superadmin-created tenants get onboarding_completed_at=now() automatically
 *  so the customer skips the plan-selection modal on first login. */
export async function adminCreateTenant(params: {
    actorUserId: string
    name:        string
    kind:        'personal' | 'organization'
    planTier:    PlanTier
    note?:       string
}): Promise<TenantDetail> {
    // Server-side validation: superadmin can only create the 3 valid combos
    const ALLOWED = new Set([
        'internal:personal',
        'internal:organization',
        'enterprise:organization',
    ])
    if (!ALLOWED.has(`${params.planTier}:${params.kind}`)) {
        throw new Error(
            `Invalid (plan_tier, kind) combination "${params.planTier}+${params.kind}". ` +
            `Allowed: Internal-Individual, Internal-Organisation, Enterprise-Organisation.`
        )
    }

    const row = await queryRow<TenantDetailRow>(
        `INSERT INTO tenants (name, kind, plan_tier, plan_changed_at, onboarding_completed_at)
         VALUES ($1, $2, $3, now(), now())
         RETURNING tenant_id, name, kind, enabled, plan_tier, trial_ends_at,
                   plan_changed_at, owner_user_id, created_at, updated_at`,
        [params.name, params.kind, params.planTier]
    )
    if (!row) throw new Error('Failed to create tenant')
    const tenant = mapTenantDetail(row)

    await logAdminAction({
        actorUserId: params.actorUserId,
        action:      'tenant.create',
        targetType:  'tenant',
        targetId:    tenant.tenantId,
        beforeValue: null,
        afterValue:  { name: tenant.name, kind: tenant.kind, planTier: tenant.planTier },
        note:        params.note ?? null,
    })

    return tenant
}

export async function adminChangePlan(params: {
    actorUserId: string
    tenantId:    string
    newPlanTier: PlanTier
    note?:       string
}): Promise<TenantDetail> {
    const before = await adminGetTenant(params.tenantId)
    if (!before) throw new Error(`Tenant ${params.tenantId} not found`)

    // A plan change implies the customer's onboarding is complete — open the
    // gate if it was still locked (typical for Pro/Team selected in the modal
    // pre-Stripe, account waited for manual fulfillment).
    const row = await queryRow<TenantDetailRow>(
        `UPDATE tenants
         SET plan_tier               = $2,
             plan_changed_at         = now(),
             onboarding_completed_at = COALESCE(onboarding_completed_at, now()),
             updated_at              = now()
         WHERE tenant_id = $1
         RETURNING tenant_id, name, kind, enabled, plan_tier, trial_ends_at,
                   plan_changed_at, owner_user_id, created_at, updated_at`,
        [params.tenantId, params.newPlanTier]
    )
    if (!row) throw new Error(`Failed to update tenant ${params.tenantId}`)
    const after = mapTenantDetail(row)

    await logAdminAction({
        actorUserId: params.actorUserId,
        action:      'tenant.change_plan',
        targetType:  'tenant',
        targetId:    params.tenantId,
        beforeValue: { planTier: before.planTier },
        afterValue:  { planTier: after.planTier },
        note:        params.note ?? null,
    })

    return after
}

export async function adminSuspendTenant(params: {
    actorUserId: string
    tenantId:    string
    note?:       string
}): Promise<TenantDetail> {
    const before = await adminGetTenant(params.tenantId)
    if (!before) throw new Error(`Tenant ${params.tenantId} not found`)

    const row = await queryRow<TenantDetailRow>(
        `UPDATE tenants
         SET enabled = false, updated_at = now()
         WHERE tenant_id = $1
         RETURNING tenant_id, name, kind, enabled, plan_tier, trial_ends_at,
                   plan_changed_at, owner_user_id, created_at, updated_at`,
        [params.tenantId]
    )
    if (!row) throw new Error(`Failed to suspend tenant ${params.tenantId}`)
    const after = mapTenantDetail(row)

    await logAdminAction({
        actorUserId: params.actorUserId,
        action:      'tenant.suspend',
        targetType:  'tenant',
        targetId:    params.tenantId,
        beforeValue: { enabled: before.enabled },
        afterValue:  { enabled: after.enabled },
        note:        params.note ?? null,
    })

    return after
}

export async function adminRestoreTenant(params: {
    actorUserId: string
    tenantId:    string
    note?:       string
}): Promise<TenantDetail> {
    const before = await adminGetTenant(params.tenantId)
    if (!before) throw new Error(`Tenant ${params.tenantId} not found`)

    const row = await queryRow<TenantDetailRow>(
        `UPDATE tenants
         SET enabled = true, updated_at = now()
         WHERE tenant_id = $1
         RETURNING tenant_id, name, kind, enabled, plan_tier, trial_ends_at,
                   plan_changed_at, owner_user_id, created_at, updated_at`,
        [params.tenantId]
    )
    if (!row) throw new Error(`Failed to restore tenant ${params.tenantId}`)
    const after = mapTenantDetail(row)

    await logAdminAction({
        actorUserId: params.actorUserId,
        action:      'tenant.restore',
        targetType:  'tenant',
        targetId:    params.tenantId,
        beforeValue: { enabled: before.enabled },
        afterValue:  { enabled: after.enabled },
        note:        params.note ?? null,
    })

    return after
}

// ─────────────────────────────────────────────────────────────────────────────
// User lookup
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminUserResult {
    userId:    string
    email:     string
    name:      string
    role:      string
    tenantId:  string | null
    tenantName: string | null
    status:    string
    createdAt: string
}

interface AdminUserRow {
    user_id:    string
    email:      string
    name:       string
    role:       string
    tenant_id:  string | null
    tenant_name: string | null
    status:     string
    created_at: Date | string
    [k: string]: unknown
}

export async function adminSearchUsers(emailLike: string, limit = 50): Promise<AdminUserResult[]> {
    const rows = await queryRows<AdminUserRow>(
        `SELECT u.user_id, u.email, u.name, u.role, u.tenant_id, t.name AS tenant_name,
                u.status, u.created_at
         FROM users u
         LEFT JOIN tenants t ON t.tenant_id = u.tenant_id
         WHERE u.email ILIKE $1
         ORDER BY u.created_at DESC
         LIMIT $2`,
        [`%${emailLike}%`, Math.min(limit, 100)]
    )
    return rows.map(r => ({
        userId:     r.user_id,
        email:      r.email,
        name:       r.name,
        role:       r.role,
        tenantId:   r.tenant_id,
        tenantName: r.tenant_name,
        status:     r.status,
        createdAt:  toIso(r.created_at),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-wide usage stats
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformStats {
    totalTenants:           number
    tenantsByPlan:          Record<PlanTier, number>
    activeTrials:           number
    expiredTrialsInGrace:   number
    suspendedTenants:       number
    topByEvents30d:         { tenantId: string; name: string; eventsUsed: number }[]
}

export async function getPlatformStats(): Promise<PlatformStats> {
    const totalTenants = Number(await queryValue<string>(
        `SELECT count(*)::bigint FROM tenants`
    ) ?? 0)

    const planRows = await queryRows<{ plan_tier: PlanTier; n: string }>(
        `SELECT plan_tier, count(*)::bigint AS n FROM tenants GROUP BY plan_tier`
    )
    const tenantsByPlan: Record<PlanTier, number> = {
        internal: 0, trial: 0, pro: 0, team: 0, enterprise: 0,
    }
    for (const r of planRows) tenantsByPlan[r.plan_tier] = Number(r.n)

    const activeTrials = Number(await queryValue<string>(
        `SELECT count(*)::bigint FROM tenants
         WHERE plan_tier = 'trial' AND trial_ends_at > now()`
    ) ?? 0)

    const expiredTrialsInGrace = Number(await queryValue<string>(
        `SELECT count(*)::bigint FROM tenants
         WHERE plan_tier = 'trial'
           AND trial_ends_at <= now()
           AND trial_ends_at + INTERVAL '7 days' > now()`
    ) ?? 0)

    const suspendedTenants = Number(await queryValue<string>(
        `SELECT count(*)::bigint FROM tenants WHERE enabled = false`
    ) ?? 0)

    const topByEvents30d = await queryRows<{ tenant_id: string; name: string; events_used: string }>(
        `SELECT t.tenant_id, t.name, COALESCE(sum(bp.events_used), 0)::bigint AS events_used
         FROM tenants t
         LEFT JOIN billing_periods bp
           ON bp.tenant_id = t.tenant_id
          AND bp.period_start > now() - INTERVAL '30 days'
         GROUP BY t.tenant_id, t.name
         ORDER BY events_used DESC NULLS LAST
         LIMIT 10`
    )

    return {
        totalTenants,
        tenantsByPlan,
        activeTrials,
        expiredTrialsInGrace,
        suspendedTenants,
        topByEvents30d: topByEvents30d.map(r => ({
            tenantId:   r.tenant_id,
            name:       r.name,
            eventsUsed: Number(r.events_used),
        })),
    }
}
