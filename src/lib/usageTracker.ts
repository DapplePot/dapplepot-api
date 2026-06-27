/**
 * Write-side of the billing/usage system. Separated from queries/billing.pg.ts
 * (read-only) so the read module stays trivially cacheable.
 *
 * Two responsibilities:
 *   1. ensureCurrentPeriod(tenantId) — make sure there's an open billing
 *      period for this tenant; create one if not. Idempotent + concurrency-safe.
 *   2. incrementUsage(tenantId, n)   — bump events_used by n. Crossings into
 *      overage are detected here and written to overage_events.
 *
 * Both are designed to be called from the ingest hot path. The first call
 * for any tenant in a fresh period will do one INSERT; subsequent calls
 * are a single UPDATE. We rely on the (tenant_id, period_start) unique
 * constraint to defuse race conditions.
 */

import { queryRow, queryValue } from './postgres.js'
import { redis } from './redis.js'
import { getCurrentPlan } from '../queries/billing.pg.js'
import { getPlanLimits, type PlanTier } from './planLimits.js'
import { dispatchNudge } from './nudgeDispatcher.js'

/**
 * Return the period_start a tenant's CURRENT billing window should anchor on.
 *
 *   trial      → tenants.created_at (a single 30-day window that does not roll)
 *   internal,
 *   pro, team,
 *   enterprise → first day of current UTC month, 00:00:00
 *
 * This is intentionally NOT subscription.current_period_start — we keep
 * usage tracking on calendar-monthly boundaries so the UI gauge resets at
 * a predictable moment regardless of when the customer subscribed. The
 * subscription period drives invoice generation; the billing_period drives
 * usage display + quota enforcement.
 */
function periodStartFor(plan: PlanTier, trialStartIso: string | null): Date {
    if (plan === 'trial' && trialStartIso) {
        return new Date(trialStartIso)
    }
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

function periodEndFor(plan: PlanTier, periodStart: Date, trialDays: number | null): Date {
    if (plan === 'trial' && trialDays) {
        return new Date(periodStart.getTime() + trialDays * 86_400_000)
    }
    // First day of NEXT month, 00:00:00 UTC
    return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

/**
 * Make sure there's an open billing_period row for this tenant. Returns
 * the period's quota so the caller (e.g. quotaCheck middleware) can
 * decide whether to allow the ingest.
 *
 * Concurrency: ON CONFLICT DO NOTHING + a follow-up SELECT — two ingests
 * racing to create the first period both succeed; only one INSERT lands.
 */
export async function ensureCurrentPeriod(tenantId: string): Promise<{
    periodId:    string
    eventsUsed:  number
    eventsQuota: number
}> {
    const plan = await getCurrentPlan(tenantId)
    if (!plan) throw new Error(`Tenant ${tenantId} not found`)

    const limits = plan.limits
    const trialStartIso = plan.planTier === 'trial' ? plan.planChangedAt : null
    const periodStart = periodStartFor(plan.planTier, trialStartIso)
    const periodEnd   = periodEndFor(plan.planTier, periodStart, limits.trialDays)
    const quota       = limits.eventsPerPeriod ?? Number.MAX_SAFE_INTEGER

    // Try to insert. If a row already exists for this (tenant_id, period_start)
    // the ON CONFLICT swallows the failure and we read the existing row below.
    await queryRow(
        `INSERT INTO billing_periods
            (tenant_id, period_start, period_end, events_quota)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, period_start) DO NOTHING`,
        [tenantId, periodStart.toISOString(), periodEnd.toISOString(), quota]
    )

    const row = await queryRow<{
        period_id:    string
        events_used:  string | number
        events_quota: string | number
    }>(
        `SELECT period_id, events_used, events_quota
         FROM billing_periods
         WHERE tenant_id = $1 AND closed_at IS NULL
         ORDER BY period_start DESC
         LIMIT 1`,
        [tenantId]
    )
    if (!row) throw new Error(`Failed to ensure period for tenant ${tenantId}`)

    return {
        periodId:    row.period_id,
        eventsUsed:  typeof row.events_used  === 'string' ? Number(row.events_used)  : row.events_used,
        eventsQuota: typeof row.events_quota === 'string' ? Number(row.events_quota) : row.events_quota,
    }
}

/**
 * Increment events_used by n for the tenant's currently-open period.
 * Updates overage_events when usage crosses quota. Cheap UPDATE in the
 * common case; called from the ingest path AFTER ClickHouse write succeeds
 * so failed inserts don't get billed.
 *
 * Returns the new events_used and whether the tenant is now over quota.
 */
export async function incrementUsage(
    tenantId: string,
    n: number
): Promise<{ eventsUsed: number; isOverQuota: boolean }> {
    if (n <= 0) return { eventsUsed: 0, isOverQuota: false }

    // UPDATE in a single round trip — overage_events math happens in-SQL
    // so we don't need a read-modify-write race.
    const row = await queryRow<{ period_id: string; events_used: string | number; events_quota: string | number; overage_events: string | number }>(
        `UPDATE billing_periods
         SET events_used = events_used + $2,
             overage_events = GREATEST(0, (events_used + $2) - events_quota)
         WHERE tenant_id = $1 AND closed_at IS NULL
         RETURNING period_id, events_used, events_quota, overage_events`,
        [tenantId, n]
    )
    if (!row) {
        // No open period — should have been ensured upstream. Caller should
        // call ensureCurrentPeriod first; we don't auto-create here to avoid
        // hiding bugs.
        return { eventsUsed: 0, isOverQuota: false }
    }

    const periodId    = row.period_id
    const eventsUsed  = typeof row.events_used  === 'string' ? Number(row.events_used)  : row.events_used
    const eventsQuota = typeof row.events_quota === 'string' ? Number(row.events_quota) : row.events_quota

    // Best-effort cache bust so the UI gauge picks up the new value fast.
    void redis.del(`dp:plan:snapshot:${tenantId}`)

    // Eager nudge dispatch — fire 80% / 100% warnings the moment we cross
    // the threshold, instead of waiting up to 24h for the daily cron. The
    // nudge_dispatch_log unique constraint guarantees idempotency, so if
    // this raced with the cron only one email goes out.
    const prevUsed = eventsUsed - n
    if (eventsUsed >= eventsQuota && prevUsed < eventsQuota) {
        void dispatchNudge({ tenantId, nudgeKind: 'quota_100', periodAnchor: periodId })
            .catch((err: Error) => console.error('[usageTracker] quota_100 nudge failed:', err.message))
    } else if (eventsUsed >= eventsQuota * 0.8 && prevUsed < eventsQuota * 0.8) {
        void dispatchNudge({ tenantId, nudgeKind: 'quota_80', periodAnchor: periodId })
            .catch((err: Error) => console.error('[usageTracker] quota_80 nudge failed:', err.message))
    }

    return { eventsUsed, isOverQuota: eventsUsed > eventsQuota }
}

/**
 * Close all open periods whose period_end has passed. Called by the
 * scripts/close_billing_period.ts cron daily. Idempotent — already-closed
 * periods are skipped by the WHERE clause.
 *
 * Returns the count of periods closed. The next ingest from each tenant
 * will lazily open a new period via ensureCurrentPeriod().
 */
export async function closeExpiredPeriods(): Promise<number> {
    const v = await queryValue<string | number>(
        `WITH closed AS (
            UPDATE billing_periods
            SET closed_at = now()
            WHERE closed_at IS NULL AND period_end < now()
            RETURNING period_id
         )
         SELECT count(*)::bigint AS n FROM closed`
    )
    return typeof v === 'string' ? Number(v) : (v ?? 0)
}
