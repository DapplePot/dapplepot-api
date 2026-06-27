/**
 * Daily cron: close expired billing_period rows.
 *
 * Run with: `pnpm tsx scripts/close_billing_period.ts`
 * Schedule once per day (UTC), ideally at 00:05 so periods close
 * just after they expire (00:00 boundary).
 *
 * Per-tenant behaviour after this script runs:
 *   - Next ingest call lazily opens a new period via
 *     ensureCurrentPeriod() inside the quotaCheck middleware.
 *   - Trial tenants whose 30-day period has closed are picked up
 *     by trialExpiry middleware on their next request (which
 *     transitions them into the grace window or full block).
 *
 * Idempotent — calling repeatedly the same day is safe; only rows
 * with closed_at IS NULL AND period_end < now() are touched.
 */

import 'dotenv/config'
import { closeExpiredPeriods } from '../src/lib/usageTracker.js'

async function main(): Promise<void> {
    const n = await closeExpiredPeriods()
    console.log(`closed ${n} expired billing period(s)`)
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('close_billing_period failed:', err)
        process.exit(1)
    })
