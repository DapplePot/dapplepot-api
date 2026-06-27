/**
 * Single entry point for sending transactional nudges (emails) with
 * idempotency guaranteed by the nudge_dispatch_log table.
 *
 * The (tenant_id, nudge_kind, period_anchor) unique constraint defuses
 * concurrent dispatches — the second caller's INSERT will conflict and
 * the dispatch is silently skipped. The actual email send happens only
 * if the INSERT succeeds.
 *
 * Two callers:
 *   1. scripts/send_nudges.ts — daily cron that scans for trial milestones
 *      and over-quota tenants and dispatches as needed.
 *   2. lib/usageTracker.ts → incrementUsage — fires quota_80 / quota_100
 *      eagerly the moment a tenant crosses each threshold, without
 *      waiting for the next cron tick.
 */

import { queryRow, queryRows } from './postgres.js'
import { emailProvider } from './email/index.js'
import {
    quotaWarningEmail,
    trialMilestoneEmail,
    lifecycleEmail,
    type QuotaWarningKind,
    type TrialMilestoneKind,
    type LifecycleKind,
} from './email/nudgeTemplates.js'

export type NudgeKind =
    | 'quota_80' | 'quota_100'
    | 'trial_day_25' | 'trial_day_30'
    | 'lifecycle_readonly_warning_30d'
    | 'lifecycle_suspension_warning'
    | 'lifecycle_deletion_warning_30d'
    | 'lifecycle_deletion_imminent'

export interface DispatchNudgeParams {
    tenantId:      string
    nudgeKind:     NudgeKind
    periodAnchor:  string
}

/**
 * Returns true if the nudge was newly dispatched, false if it was
 * already sent for this (tenant, kind, anchor) — i.e. duplicate suppressed.
 */
export async function dispatchNudge(params: DispatchNudgeParams): Promise<boolean> {
    // Look up the tenant's owner email (the "primary contact").
    // For Free Trial / Pro this is just the single user; for Team we
    // fall back to the first admin. Enterprise nudges aren't sent here
    // since their flow is human-led.
    const recipient = await queryRow<{ email: string }>(
        `SELECT u.email
         FROM users u
         JOIN tenant_members tm ON tm.user_id = u.user_id AND tm.tenant_id = $1
         WHERE u.status = 'active'
         ORDER BY CASE WHEN tm.role = 'admin' THEN 0 ELSE 1 END, u.created_at
         LIMIT 1`,
        [params.tenantId]
    )
    if (!recipient) return false   // No recipient — silently skip

    // Try to claim the dedup slot. If another process beat us, return false.
    const claim = await queryRow<{ dispatch_id: string }>(
        `INSERT INTO nudge_dispatch_log
            (tenant_id, nudge_kind, period_anchor, delivered_via, recipient)
         VALUES ($1, $2, $3, 'email', $4)
         ON CONFLICT (tenant_id, nudge_kind, period_anchor) DO NOTHING
         RETURNING dispatch_id`,
        [params.tenantId, params.nudgeKind, params.periodAnchor, recipient.email]
    )
    if (!claim) return false   // Already dispatched

    // Build + send the email. Errors are logged on the dispatch row
    // for forensic review but never bubble up (so the cron stays alive).
    try {
        if (params.nudgeKind === 'quota_80' || params.nudgeKind === 'quota_100') {
            await emailProvider.send(quotaWarningEmail({
                to:   recipient.email,
                kind: params.nudgeKind.replace('quota_', '') as QuotaWarningKind,
            }))
        } else if (params.nudgeKind.startsWith('trial_day_')) {
            await emailProvider.send(trialMilestoneEmail({
                to:   recipient.email,
                kind: params.nudgeKind.replace('trial_day_', 'day_') as TrialMilestoneKind,
            }))
        } else if (params.nudgeKind.startsWith('lifecycle_')) {
            await emailProvider.send(lifecycleEmail({
                to:   recipient.email,
                kind: params.nudgeKind.replace('lifecycle_', '') as LifecycleKind,
            }))
        }
        return true
    } catch (err) {
        await queryRow(
            `UPDATE nudge_dispatch_log SET error_message = $2 WHERE dispatch_id = $1`,
            [claim.dispatch_id, (err as Error).message.slice(0, 500)]
        )
        return false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan + dispatch helpers used by the daily cron
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchTrialMilestoneNudges(): Promise<{ dispatched: number; skipped: number }> {
    // Find trial tenants and compute "days into trial" for each
    type Row = { tenant_id: string; trial_ends_at: Date | string; days_into_trial: number }
    const rows = await queryRows<Row>(
        `SELECT tenant_id,
                trial_ends_at,
                EXTRACT(EPOCH FROM (now() - (trial_ends_at - INTERVAL '30 days'))) / 86400 AS days_into_trial
         FROM tenants
         WHERE plan_tier = 'trial'
           AND trial_ends_at IS NOT NULL
           AND enabled = true`
    )

    let dispatched = 0
    let skipped    = 0

    for (const r of rows) {
        const day = Math.floor(Number(r.days_into_trial))
        // Quiet trial — only urgency-day milestones now (day 25 + day 30).
        // Lifecycle nudges (readonly/suspension/deletion) are dispatched
        // separately by dispatchLifecycleNudges() based on lifecycle state.
        let kind: NudgeKind | null = null
        if (day === 25) kind = 'trial_day_25'
        if (day === 30) kind = 'trial_day_30'
        if (!kind) continue

        const trialEndsAtIso = r.trial_ends_at instanceof Date
            ? r.trial_ends_at.toISOString()
            : String(r.trial_ends_at)
        const ok = await dispatchNudge({
            tenantId:     r.tenant_id,
            nudgeKind:    kind,
            periodAnchor: trialEndsAtIso,
        })
        if (ok) dispatched++; else skipped++
    }
    return { dispatched, skipped }
}

/**
 * Lifecycle nudges — fired by the daily cron based on how long the tenant
 * has been in each lifecycle state. Anchored to lifecycle_changed_at so
 * each transition gets its own nudge once.
 */
export async function dispatchLifecycleNudges(): Promise<{ dispatched: number; skipped: number }> {
    type Row = {
        tenant_id: string
        lifecycle_state: 'readonly' | 'suspended'
        days_in_state: number
        lifecycle_changed_at: Date | string
    }
    const rows = await queryRows<Row>(
        `SELECT tenant_id,
                lifecycle_state,
                lifecycle_changed_at,
                EXTRACT(EPOCH FROM (now() - lifecycle_changed_at)) / 86400 AS days_in_state
         FROM tenants
         WHERE lifecycle_state IN ('readonly', 'suspended')
           AND enabled = true`
    )

    let dispatched = 0
    let skipped    = 0

    for (const r of rows) {
        const days = Math.floor(Number(r.days_in_state))
        let kind: NudgeKind | null = null

        if (r.lifecycle_state === 'readonly') {
            // 30 days before suspension at day 90 → fires on day 60 of readonly
            if (days === 60) kind = 'lifecycle_readonly_warning_30d'
        } else {
            // suspended
            if (days === 0)  kind = 'lifecycle_suspension_warning'   // fired on entry
            if (days === 60) kind = 'lifecycle_deletion_warning_30d' // 30 days before delete
            if (days === 89) kind = 'lifecycle_deletion_imminent'    // 24h before delete
        }
        if (!kind) continue

        const anchor = r.lifecycle_changed_at instanceof Date
            ? r.lifecycle_changed_at.toISOString()
            : String(r.lifecycle_changed_at)
        const ok = await dispatchNudge({ tenantId: r.tenant_id, nudgeKind: kind, periodAnchor: anchor })
        if (ok) dispatched++; else skipped++
    }
    return { dispatched, skipped }
}

export async function dispatchOverQuotaNudges(): Promise<{ dispatched: number; skipped: number }> {
    // Find open billing periods at >=80% or >=100% of quota
    type Row = { period_id: string; tenant_id: string; pct: number }
    const rows = await queryRows<Row>(
        `SELECT period_id, tenant_id,
                CASE WHEN events_quota > 0
                     THEN (events_used::numeric / events_quota::numeric)
                     ELSE 0 END AS pct
         FROM billing_periods
         WHERE closed_at IS NULL AND events_quota > 0`
    )

    let dispatched = 0
    let skipped    = 0

    for (const r of rows) {
        const pct = Number(r.pct)
        if (pct >= 1.0) {
            const ok = await dispatchNudge({
                tenantId:     r.tenant_id,
                nudgeKind:    'quota_100',
                periodAnchor: r.period_id,
            })
            if (ok) dispatched++; else skipped++
        } else if (pct >= 0.8) {
            const ok = await dispatchNudge({
                tenantId:     r.tenant_id,
                nudgeKind:    'quota_80',
                periodAnchor: r.period_id,
            })
            if (ok) dispatched++; else skipped++
        }
    }
    return { dispatched, skipped }
}
