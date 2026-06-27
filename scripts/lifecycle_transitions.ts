/**
 * Daily cron: promote tenants through the lifecycle states.
 *
 * Run with: pnpm tsx scripts/lifecycle_transitions.ts
 * Schedule once per day at 00:30 UTC (after close_billing_period @ 00:05).
 *
 *   active     →  trial ended           : promote to 'readonly'        (trial only)
 *   readonly   →  N days in readonly    : promote to 'suspended'
 *   suspended  →  90 days in suspended  : promote to 'deleted'
 *                                         (delete_expired_tenants.ts removes data)
 *
 * Per-tier readonly windows:
 *   - trial:           90 days
 *   - pro/team/enterprise (after cancellation): 730 days (2 years)
 *   - internal:        N/A (never enters readonly)
 *
 * Past-due paid tenants are deliberately skipped — their subscription.status
 * is 'past_due' (not 'cancelled'), so the WHERE clauses below exclude them.
 * They stay in readonly indefinitely until they pay or LS cancels them.
 *
 * Idempotent: each UPDATE has a guard so re-running mid-day is a no-op.
 */

import 'dotenv/config'
import postgres from 'postgres'
import { getPlanLimits } from '../src/lib/planLimits.js'

const TRIAL_READONLY  = getPlanLimits('trial').readonlyDays   // 90
const PAID_READONLY   = getPlanLimits('pro').readonlyDays     // 730 (same for team + enterprise)
const SUSPENDED_DAYS  = getPlanLimits('trial').suspendedDays  // 90 (same across all paid tiers too)

async function main(): Promise<void> {
    const ssl = process.env.POSTGRES_SSL === 'true' ? 'require' : false
    const sql = postgres(process.env.POSTGRES_URL!, { ssl })

    try {
        // 1. active → readonly  (trial ended)
        // Paid customers move to readonly via webhook (cancellation / payment failed),
        // not via this cron. Only trial tenants are time-based via trial_ends_at.
        const r1 = await sql<{ tenant_id: string }[]>`
            UPDATE tenants
            SET lifecycle_state       = 'readonly',
                lifecycle_changed_at  = now(),
                updated_at            = now()
            WHERE lifecycle_state = 'active'
              AND plan_tier       = 'trial'
              AND trial_ends_at   IS NOT NULL
              AND trial_ends_at   < now()
              AND enabled         = true
            RETURNING tenant_id
        `
        console.log(`active → readonly  : ${r1.length} tenant(s)`)

        // 2. readonly → suspended
        // - Trial tenants: 90 days fixed
        // - Paid tenants (pro/team/enterprise): 730 days, BUT only if their
        //   subscription has been cancelled (not still past_due). Past-due
        //   subs are filtered out by joining and checking status='cancelled'.
        const r2 = await sql<{ tenant_id: string }[]>`
            UPDATE tenants t
            SET lifecycle_state      = 'suspended',
                lifecycle_changed_at = now(),
                updated_at           = now()
            WHERE t.lifecycle_state = 'readonly'
              AND t.enabled         = true
              AND (
                -- Trial: time-based, fixed 90-day window
                (t.plan_tier = 'trial'
                 AND t.lifecycle_changed_at < now() - INTERVAL '${sql.unsafe(String(TRIAL_READONLY))} days')
                OR
                -- Paid cancelled: 730 days from last paid period end
                (t.plan_tier IN ('pro', 'team', 'enterprise')
                 AND t.lifecycle_changed_at < now() - INTERVAL '${sql.unsafe(String(PAID_READONLY))} days'
                 AND EXISTS (
                    SELECT 1 FROM subscriptions s
                    WHERE s.tenant_id = t.tenant_id
                      AND s.status    = 'cancelled'
                 ))
              )
            RETURNING t.tenant_id
        `
        console.log(`readonly → suspended : ${r2.length} tenant(s)`)

        // 3. suspended → deleted  (90 days in suspended; data wipe is separate)
        // Same 90-day window for everyone — applies to all tiers that reached suspended.
        const r3 = await sql<{ tenant_id: string }[]>`
            UPDATE tenants
            SET lifecycle_state      = 'deleted',
                lifecycle_changed_at = now(),
                updated_at           = now()
            WHERE lifecycle_state       = 'suspended'
              AND lifecycle_changed_at  < now() - INTERVAL '${sql.unsafe(String(SUSPENDED_DAYS))} days'
              AND enabled               = true
            RETURNING tenant_id
        `
        console.log(`suspended → deleted : ${r3.length} tenant(s)`)
    } finally {
        await sql.end()
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('lifecycle_transitions failed:', err); process.exit(1) })
