/**
 * Daily cron: scan for trial milestones + over-quota tenants and dispatch
 * any pending transactional emails.
 *
 * Run with: `pnpm tsx scripts/send_nudges.ts`
 * Schedule once per day at 09:00 in the customer's preferred TZ (we use
 * UTC 08:00 = 13:30 IST for the Indian market — adjust per launch geo).
 *
 * Idempotent: nudge_dispatch_log's unique constraint ensures each
 * (tenant, kind, anchor) fires at most once. Safe to re-run on the
 * same day.
 */

import 'dotenv/config'
import {
    dispatchTrialMilestoneNudges,
    dispatchLifecycleNudges,
    dispatchOverQuotaNudges,
} from '../src/lib/nudgeDispatcher.js'

async function main(): Promise<void> {
    const trial = await dispatchTrialMilestoneNudges()
    console.log(`trial milestones: dispatched=${trial.dispatched} skipped=${trial.skipped}`)

    const lifecycle = await dispatchLifecycleNudges()
    console.log(`lifecycle nudges: dispatched=${lifecycle.dispatched} skipped=${lifecycle.skipped}`)

    const quota = await dispatchOverQuotaNudges()
    console.log(`quota warnings:   dispatched=${quota.dispatched} skipped=${quota.skipped}`)
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('send_nudges failed:', err)
        process.exit(1)
    })
