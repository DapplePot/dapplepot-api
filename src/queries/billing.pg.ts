/**
 * Billing & plan-tier query helpers.
 *
 * Reads-only here. Writes (plan changes, subscription create/update,
 * usage increment) live in routes/admin/*.ts and the ingestion path
 * respectively, to keep this module side-effect-free and trivially
 * cacheable.
 *
 * Hot-path callers (quotaCheck middleware, ingest route) should layer
 * their own short-lived cache on top of these (e.g. Redis with 60s TTL
 * keyed by tenant_id) — see lib/cache.ts for the pattern used elsewhere.
 */

import { queryRow, queryRows, queryValue } from '../lib/postgres.js'
import {
    type PlanTier,
    type PlanLimits,
    getPlanLimits,
} from '../lib/planLimits.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TenantPlanRow extends Record<string, unknown> {
    tenant_id:                    string
    plan_tier:                    PlanTier
    trial_ends_at:                Date | string | null
    plan_changed_at:              Date | string
    onboarding_completed_at:      Date | string | null
    lifecycle_state:              'active' | 'readonly' | 'suspended' | 'deleted'
    lifecycle_changed_at:         Date | string
    enabled:                      boolean
    enterprise_seats_cap:         number | null
    enterprise_events_per_period: number | string | null
}

interface SubscriptionRow extends Record<string, unknown> {
    subscription_id:        string
    tenant_id:              string
    plan_tier:              'pro' | 'team' | 'enterprise'
    billing_cycle:          'monthly' | 'annual'
    status:                 'active' | 'past_due' | 'cancelled' | 'paused'
    current_period_start:   Date | string
    current_period_end:     Date | string
    cancel_at:                Date | string | null
    billing_provider:         string
    external_subscription_id: string | null
    external_customer_id:     string | null
    created_at:               Date | string
    updated_at:               Date | string
}

interface BillingPeriodRow extends Record<string, unknown> {
    period_id:      string
    tenant_id:      string
    period_start:   Date | string
    period_end:     Date | string
    events_used:    string | number   // BIGINT → string in node-postgres
    events_quota:   string | number
    overage_events: string | number
    closed_at:      Date | string | null
}

export interface TenantPlan {
    tenantId:               string
    planTier:               PlanTier
    trialEndsAt:            string | null
    planChangedAt:          string
    /** NULL until the tenant has chosen a plan in the post-signup modal.
     *  Drives the UI OnboardingGate + the requireOnboardingComplete middleware. */
    onboardingCompletedAt:  string | null
    /** Lifecycle state — drives the readonly banner and suspended hard-lock UI. */
    lifecycleState:         'active' | 'readonly' | 'suspended' | 'deleted'
    /** When the tenant entered its current lifecycle_state. Used by the UI
     *  to compute "days until suspension/deletion" countdown copy. */
    lifecycleChangedAt:     string
    enabled:                boolean
    /** Effective limits — equal to PLAN_LIMITS[planTier] unless an
     *  enterprise subscription overrides them (not yet implemented). */
    limits:                 PlanLimits
}

export interface Subscription {
    subscriptionId:         string
    tenantId:               string
    planTier:               'pro' | 'team' | 'enterprise'
    billingCycle:           'monthly' | 'annual'
    status:                 'active' | 'past_due' | 'cancelled' | 'paused'
    currentPeriodStart:     string
    currentPeriodEnd:       string
    cancelAt:               string | null
    billingProvider:        string
    externalSubscriptionId: string | null
    externalCustomerId:     string | null
    createdAt:              string
    updatedAt:              string
}

export interface BillingPeriod {
    periodId:      string
    tenantId:      string
    periodStart:   string
    periodEnd:     string
    eventsUsed:    number
    eventsQuota:   number
    overageEvents: number
    closedAt:      string | null
}

export interface UsageSnapshot {
    eventsUsed:    number
    eventsQuota:   number
    overageEvents: number
    /** events_used / events_quota, 0–1+ (can exceed 1 for paid tiers). */
    pct:           number
    periodStart:   string
    periodEnd:     string
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers (snake_case row → camelCase domain object)
// ─────────────────────────────────────────────────────────────────────────────

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}
function toIsoOrNull(d: Date | string | null): string | null {
    return d === null ? null : toIso(d)
}
function toBigIntNumber(v: string | number): number {
    // BIGINT comes back as a string from node-postgres for safety on large
    // values; for event counts we're well within JS safe-integer range.
    return typeof v === 'string' ? Number(v) : v
}

function mapSubscription(r: SubscriptionRow): Subscription {
    return {
        subscriptionId:         r.subscription_id,
        tenantId:               r.tenant_id,
        planTier:               r.plan_tier,
        billingCycle:           r.billing_cycle,
        status:                 r.status,
        currentPeriodStart:     toIso(r.current_period_start),
        currentPeriodEnd:       toIso(r.current_period_end),
        cancelAt:               toIsoOrNull(r.cancel_at),
        billingProvider:        r.billing_provider,
        externalSubscriptionId: r.external_subscription_id,
        externalCustomerId:     r.external_customer_id,
        createdAt:              toIso(r.created_at),
        updatedAt:              toIso(r.updated_at),
    }
}

function mapBillingPeriod(r: BillingPeriodRow): BillingPeriod {
    return {
        periodId:      r.period_id,
        tenantId:      r.tenant_id,
        periodStart:   toIso(r.period_start),
        periodEnd:     toIso(r.period_end),
        eventsUsed:    toBigIntNumber(r.events_used),
        eventsQuota:   toBigIntNumber(r.events_quota),
        overageEvents: toBigIntNumber(r.overage_events),
        closedAt:      toIsoOrNull(r.closed_at),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan / tier reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical plan-tier read. Returns null if the tenant doesn't exist.
 * Should be cached on the request scope to avoid re-querying multiple
 * times in the same request lifecycle.
 */
export async function getCurrentPlan(tenantId: string): Promise<TenantPlan | null> {
    const row = await queryRow<TenantPlanRow>(
        `SELECT tenant_id, plan_tier, trial_ends_at, plan_changed_at,
                onboarding_completed_at, lifecycle_state, lifecycle_changed_at, enabled,
                enterprise_seats_cap, enterprise_events_per_period
         FROM tenants
         WHERE tenant_id = $1`,
        [tenantId]
    )
    if (!row) return null

    // For Enterprise tenants, the contract-specific overrides on the tenant
    // row supersede the planLimits.ts defaults of "unlimited / use-override".
    const baseLimits = getPlanLimits(row.plan_tier)
    const limits = row.plan_tier === 'enterprise'
        ? {
            ...baseLimits,
            maxSeats:        row.enterprise_seats_cap         ?? baseLimits.maxSeats,
            eventsPerPeriod: row.enterprise_events_per_period != null
                ? Number(row.enterprise_events_per_period)
                : baseLimits.eventsPerPeriod,
        }
        : baseLimits

    return {
        tenantId:              row.tenant_id,
        planTier:              row.plan_tier,
        trialEndsAt:           toIsoOrNull(row.trial_ends_at),
        planChangedAt:         toIso(row.plan_changed_at),
        onboardingCompletedAt: toIsoOrNull(row.onboarding_completed_at),
        lifecycleState:        row.lifecycle_state,
        lifecycleChangedAt:    toIso(row.lifecycle_changed_at),
        enabled:               row.enabled,
        limits,
    }
}

/**
 * Get the active subscription row for a tenant. Returns null for tenants
 * on `trial` or `internal` (which have no subscription row by design).
 */
export async function getSubscription(tenantId: string): Promise<Subscription | null> {
    const row = await queryRow<SubscriptionRow>(
        `SELECT subscription_id, tenant_id, plan_tier, billing_cycle, status,
                current_period_start, current_period_end, cancel_at,
                billing_provider, external_subscription_id, external_customer_id,
                created_at, updated_at
         FROM subscriptions
         WHERE tenant_id = $1`,
        [tenantId]
    )
    return row ? mapSubscription(row) : null
}

/**
 * True iff the tenant is on plan_tier='trial' AND now() > trial_ends_at + grace.
 * Returns false for any other tier (incl. expired tenants who've already been
 * moved off trial by the cron). Application code should use this together
 * with the requireWritableTenant middleware — this helper exists so other code paths
 * (UI banners, reports) can ask without going through middleware semantics.
 */
export async function isTrialExpired(tenantId: string): Promise<boolean> {
    const plan = await getCurrentPlan(tenantId)
    if (!plan || plan.planTier !== 'trial' || !plan.trialEndsAt) return false
    return Date.now() > new Date(plan.trialEndsAt).getTime()
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage / billing-period reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the currently-open billing period for a tenant, or null if none
 * exists. Callers that need to MAKE one if missing should use
 * ensureCurrentPeriod() instead — keeping this function read-only.
 */
export async function getCurrentPeriod(tenantId: string): Promise<BillingPeriod | null> {
    const row = await queryRow<BillingPeriodRow>(
        `SELECT period_id, tenant_id, period_start, period_end,
                events_used, events_quota, overage_events, closed_at
         FROM billing_periods
         WHERE tenant_id = $1 AND closed_at IS NULL
         LIMIT 1`,
        [tenantId]
    )
    return row ? mapBillingPeriod(row) : null
}

/**
 * Combined snapshot for dashboard / UI consumption: usage + quota + pct.
 * Returns sensible defaults when no period exists yet so the UI never sees
 * undefined gauges.
 */
export async function getUsageSnapshot(tenantId: string): Promise<UsageSnapshot> {
    const period = await getCurrentPeriod(tenantId)
    if (!period) {
        const plan = await getCurrentPlan(tenantId)
        const quota = plan?.limits.eventsPerPeriod ?? 0
        const nowIso = new Date().toISOString()
        return {
            eventsUsed:    0,
            eventsQuota:   quota,
            overageEvents: 0,
            pct:           0,
            periodStart:   nowIso,
            periodEnd:     nowIso,
        }
    }

    const pct = period.eventsQuota > 0
        ? period.eventsUsed / period.eventsQuota
        : 0

    return {
        eventsUsed:    period.eventsUsed,
        eventsQuota:   period.eventsQuota,
        overageEvents: period.overageEvents,
        pct,
        periodStart:   period.periodStart,
        periodEnd:     period.periodEnd,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource counts (for enforcement)
// ─────────────────────────────────────────────────────────────────────────────

/** Count of registered agents for the tenant. Used by createAgent cap check. */
export async function getAgentCount(tenantId: string): Promise<number> {
    const v = await queryValue<string | number>(
        `SELECT count(*)::bigint AS n FROM agents WHERE tenant_id = $1`,
        [tenantId]
    )
    return typeof v === 'string' ? Number(v) : (v ?? 0)
}

/** Count of seats (tenant_members) for the tenant. Used by invite cap check. */
export async function getSeatCount(tenantId: string): Promise<number> {
    const v = await queryValue<string | number>(
        `SELECT count(*)::bigint AS n FROM tenant_members WHERE tenant_id = $1`,
        [tenantId]
    )
    return typeof v === 'string' ? Number(v) : (v ?? 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined helper for the /me/plan endpoint
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanSnapshot {
    plan:         TenantPlan
    subscription: Subscription | null
    usage:        UsageSnapshot
    agentCount:   number
    seatCount:    number
    trialDaysLeft: number | null   // null when not on trial
}

/**
 * One-shot bundle for the UI: everything the dashboard needs to render
 * the current plan card, usage gauge, and gating decisions.
 */
export async function getPlanSnapshot(tenantId: string): Promise<PlanSnapshot | null> {
    const plan = await getCurrentPlan(tenantId)
    if (!plan) return null

    const [subscription, usage, agentCount, seatCount] = await Promise.all([
        getSubscription(tenantId),
        getUsageSnapshot(tenantId),
        getAgentCount(tenantId),
        getSeatCount(tenantId),
    ])

    let trialDaysLeft: number | null = null
    if (plan.planTier === 'trial' && plan.trialEndsAt) {
        const msLeft = new Date(plan.trialEndsAt).getTime() - Date.now()
        trialDaysLeft = Math.max(0, Math.ceil(msLeft / 86_400_000))
    }

    return { plan, subscription, usage, agentCount, seatCount, trialDaysLeft }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-side list (used by Superadmin Dashboard in Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

export interface TenantListFilter {
    planTier?: PlanTier
    enabled?:  boolean
    search?:   string   // tenant name ILIKE
    limit?:    number
    offset?:   number
}

interface TenantListRow extends TenantPlanRow {
    name:         string
    kind:         'personal' | 'organization'
    created_at:   Date | string
}

export interface TenantListItem {
    tenantId:      string
    name:          string
    kind:          'personal' | 'organization'
    planTier:      PlanTier
    enabled:       boolean
    trialEndsAt:   string | null
    planChangedAt: string
    createdAt:     string
}

export async function listTenantsForAdmin(filter: TenantListFilter = {}): Promise<TenantListItem[]> {
    const conditions: string[] = []
    const params:     unknown[] = []
    let   i           = 1

    if (filter.planTier) {
        conditions.push(`plan_tier = $${i++}`)
        params.push(filter.planTier)
    }
    if (filter.enabled !== undefined) {
        conditions.push(`enabled = $${i++}`)
        params.push(filter.enabled)
    }
    if (filter.search) {
        conditions.push(`name ILIKE $${i++}`)
        params.push(`%${filter.search}%`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(filter.limit ?? 50, 200)
    const offset = filter.offset ?? 0

    const rows = await queryRows<TenantListRow>(
        `SELECT tenant_id, name, kind, plan_tier, enabled,
                trial_ends_at, plan_changed_at, created_at
         FROM tenants
         ${where}
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
    )

    return rows.map(r => ({
        tenantId:      r.tenant_id,
        name:          r.name,
        kind:          r.kind,
        planTier:      r.plan_tier,
        enabled:       r.enabled,
        trialEndsAt:   toIsoOrNull(r.trial_ends_at),
        planChangedAt: toIso(r.plan_changed_at),
        createdAt:     toIso(r.created_at),
    }))
}
