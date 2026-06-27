/**
 * Seeds 5 pre-baked test tenants matching the scenarios in e2e_test_flows.md.
 * Re-runnable: upserts on tenant name + user email so you can rebuild state
 * mid-testing without `DELETE FROM tenants CASCADE`.
 *
 * Usage:  pnpm tsx scripts/seed_test_tenants.ts
 * Reset:  pnpm tsx scripts/seed_test_tenants.ts --reset   (drops + re-creates)
 *
 * Seeded tenants
 * ──────────────
 *   1.  Internal Test          — perpetual comp account, no caps
 *   2.  Trial Day 1            — fresh trial, 29 days remaining (no banner)
 *   3.  Trial Day 28           — 2 days left (amber banner) — day_30 nudge soon
 *   4.  Trial Readonly         — lifecycle='readonly', 70 days until suspension
 *   5.  Trial Suspended        — lifecycle='suspended', 30 days until deletion
 *   6.  Pro at 80% Quota       — healthy Pro, 40k of 50k events used (amber)
 *   7.  Pro Past Due           — Pro w/ failed payment, dark-red PastDueBanner
 *   8.  Pro Cancelled Recent   — Pro cancelled 30d ago, 700d readonly left
 *   9.  Pro Cancelled Long Ago — Pro cancelled ~700d ago, 30d to auto-suspend
 *   10. Pro Suspended          — Pro hard-locked, 30d to data deletion
 *
 * All tenants get one admin user with predictable credentials. Log in as any
 * of them via the standard /login flow.
 */

import 'dotenv/config'
import bcrypt from 'bcryptjs'
const { hashSync } = bcrypt
import postgres from 'postgres'
import { randomBytes, createHash } from 'crypto'

function generateSdkKey(): { rawKey: string; keyHash: string; maskedKey: string } {
    const rawKey    = 'dp_sk_' + randomBytes(16).toString('hex')      // 38-char total
    const keyHash   = createHash('sha256').update(rawKey).digest('hex')
    const maskedKey = rawKey.slice(0, 10) + '…' + rawKey.slice(-4)
    return { rawKey, keyHash, maskedKey }
}

const PASSWORD = 'TestTenant123!'   // Shared across all test users for convenience
const PASSWORD_HASH = hashSync(PASSWORD, 12)

const TENANTS = [
    {
        key:           'internal',
        name:          'Internal Test',
        email:         'test+internal@dapplepot.dev',
        kind:          'organization' as const,
        planTier:      'internal' as const,
        trialOffset:   null as number | null,
        sub:           null,
        usage:         { events: 0,     quota: 5_000   },
    },
    {
        key:           'trial-day-1',
        name:          'Trial Day 1',
        email:         'test+trial-day-1@dapplepot.dev',
        kind:          'personal' as const,
        planTier:      'trial' as const,
        trialOffset:   +29,   // trial_ends_at = now() + 29 days
        sub:           null,
        usage:         { events: 50,    quota: 10_000  },
    },
    {
        key:           'trial-day-28',
        name:          'Trial Day 28',
        email:         'test+trial-day-28@dapplepot.dev',
        kind:          'personal' as const,
        planTier:      'trial' as const,
        trialOffset:   +2,    // trial_ends_at = now() + 2 days (day 28 of trial)
        sub:           null,
        usage:         { events: 7_200, quota: 10_000  },
    },
    {
        key:             'trial-readonly',
        name:            'Trial Readonly',
        email:           'test+trial-readonly@dapplepot.dev',
        kind:            'personal' as const,
        planTier:        'trial' as const,
        trialOffset:     -20,   // trial ended 20 days ago — 70 days of readonly left
        sub:             null,
        usage:           { events: 10_000, quota: 10_000 },
        lifecycleState:  'readonly' as const,
        lifecycleDaysIn: 20,    // 20 days into the readonly window
    },
    {
        key:             'trial-suspended',
        name:            'Trial Suspended',
        email:           'test+trial-suspended@dapplepot.dev',
        kind:            'personal' as const,
        planTier:        'trial' as const,
        trialOffset:     -150,  // trial ended 150 days ago — well into suspension
        sub:             null,
        usage:           { events: 10_000, quota: 10_000 },
        lifecycleState:  'suspended' as const,
        lifecycleDaysIn: 60,    // 60 days into the suspended window (30 days from deletion)
    },
    {
        key:           'pro-80pct',
        name:          'Pro at 80% Quota',
        email:         'test+pro-80pct@dapplepot.dev',
        kind:          'personal' as const,
        planTier:      'pro' as const,
        trialOffset:   null,
        sub:           { billingCycle: 'monthly' as const, periodOffsetDays: -10, status: 'active' as const },
        usage:         { events: 40_000, quota: 50_000 },
    },
    {
        key:             'pro-past-due',
        name:            'Pro Past Due',
        email:           'test+pro-past-due@dapplepot.dev',
        kind:            'personal' as const,
        planTier:        'pro' as const,
        trialOffset:     null,
        // Renewal payment failed 3 days ago — LS dunning in progress.
        sub:             { billingCycle: 'monthly' as const, periodOffsetDays: -33, status: 'past_due' as const },
        usage:           { events: 22_500, quota: 50_000 },
        lifecycleState:  'readonly' as const,
        lifecycleDaysIn: 3,    // anchored 3 days ago — no auto-decay (past_due is indefinite)
    },
    {
        key:             'pro-cancelled-fresh',
        name:            'Pro Cancelled Recent',
        email:           'test+pro-cancelled-fresh@dapplepot.dev',
        kind:            'personal' as const,
        planTier:        'pro' as const,
        trialOffset:     null,
        // Cancelled 30 days ago — 700 days of read-only access remaining.
        sub:             { billingCycle: 'monthly' as const, periodOffsetDays: -60, status: 'cancelled' as const },
        usage:           { events: 0, quota: 50_000 },
        lifecycleState:  'readonly' as const,
        lifecycleDaysIn: 30,   // 30 days into the 730-day readonly window
    },
    {
        key:             'pro-cancelled-old',
        name:            'Pro Cancelled Long Ago',
        email:           'test+pro-cancelled-old@dapplepot.dev',
        kind:            'personal' as const,
        planTier:        'pro' as const,
        trialOffset:     null,
        // Cancelled ~700 days ago — only 30 days until suspension. Tests the
        // late-stage readonly UX and lifecycle cron promotion threshold.
        sub:             { billingCycle: 'monthly' as const, periodOffsetDays: -730, status: 'cancelled' as const },
        usage:           { events: 0, quota: 50_000 },
        lifecycleState:  'readonly' as const,
        lifecycleDaysIn: 700,  // 700 days in — 30 days from auto-suspend
    },
    {
        key:             'pro-suspended',
        name:            'Pro Suspended',
        email:           'test+pro-suspended@dapplepot.dev',
        kind:            'personal' as const,
        planTier:        'pro' as const,
        trialOffset:     null,
        // Cancelled long enough ago that the readonly window elapsed and the
        // tenant was already promoted to 'suspended'. 60 days in = 30 to delete.
        sub:             { billingCycle: 'monthly' as const, periodOffsetDays: -880, status: 'cancelled' as const },
        usage:           { events: 0, quota: 50_000 },
        lifecycleState:  'suspended' as const,
        lifecycleDaysIn: 60,   // 60 days into the 90-day suspended window
    },
] as const

function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 86_400_000)
}

function monthStart(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function monthEnd(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

async function main() {
    const reset = process.argv.includes('--reset')

    const ssl = process.env.POSTGRES_SSL === 'true' ? 'require' : false
    const sql = postgres(process.env.POSTGRES_URL!, { ssl })

    try {
        if (reset) {
            console.log('Resetting test tenants…')
            for (const t of TENANTS) {
                // CASCADE drops users, agents, billing_periods, subscriptions, etc.
                await sql`DELETE FROM tenants WHERE name = ${t.name}`
            }
        }

        console.log('Seeding test tenants…\n')

        for (const t of TENANTS) {
            const trialEndsAt: Date | null = t.trialOffset === null
                ? null
                : daysFromNow(t.trialOffset)

            // ── 1. Tenant row — manual upsert (tenants.name has no unique index) ──
            // Lifecycle fields — default to 'active' unless the tenant config
            // specifies a different state (used to seed readonly + suspended scenarios).
            const lifecycleState   = ('lifecycleState'  in t ? (t as { lifecycleState:  'active' | 'readonly' | 'suspended' | 'deleted' }).lifecycleState  : 'active')
            const lifecycleDaysIn  = ('lifecycleDaysIn' in t ? (t as { lifecycleDaysIn: number }).lifecycleDaysIn : 0)
            const lifecycleChangedAt = daysFromNow(-lifecycleDaysIn)

            const existingTenant = await sql<{ tenant_id: string }[]>`
                SELECT tenant_id FROM tenants WHERE name = ${t.name} LIMIT 1
            `
            let tenantId: string
            if (existingTenant.length > 0) {
                tenantId = existingTenant[0]!.tenant_id
                await sql`
                    UPDATE tenants
                    SET kind                    = ${t.kind},
                        plan_tier               = ${t.planTier},
                        trial_ends_at           = ${trialEndsAt},
                        plan_changed_at         = now(),
                        onboarding_completed_at = now(),
                        lifecycle_state         = ${lifecycleState},
                        lifecycle_changed_at    = ${lifecycleChangedAt},
                        enabled                 = true,
                        updated_at              = now()
                    WHERE tenant_id = ${tenantId}
                `
            } else {
                // Seeded tenants skip the post-signup gate so testers can log
                // straight into the scenario state without picking a plan.
                const rows = await sql<{ tenant_id: string }[]>`
                    INSERT INTO tenants (name, kind, plan_tier, trial_ends_at,
                                         plan_changed_at, onboarding_completed_at,
                                         lifecycle_state, lifecycle_changed_at)
                    VALUES (${t.name}, ${t.kind}, ${t.planTier}, ${trialEndsAt},
                            now(), now(),
                            ${lifecycleState}, ${lifecycleChangedAt})
                    RETURNING tenant_id
                `
                const row = rows[0]
                if (!row) throw new Error(`Failed to insert tenant ${t.name}`)
                tenantId = row.tenant_id
            }

            // ── 2. Admin user — manual upsert on LOWER(email) ─────────────────────
            const existingUser = await sql<{ user_id: string }[]>`
                SELECT user_id FROM users WHERE LOWER(email) = LOWER(${t.email}) LIMIT 1
            `
            let userId: string
            if (existingUser.length > 0) {
                userId = existingUser[0]!.user_id
                await sql`
                    UPDATE users
                    SET tenant_id         = ${tenantId},
                        name              = ${t.name + ' Admin'},
                        password_hash     = ${PASSWORD_HASH},
                        role              = 'admin',
                        status            = 'active',
                        email_verified_at = COALESCE(email_verified_at, now()),
                        updated_at        = now()
                    WHERE user_id = ${userId}
                `
            } else {
                const rows = await sql<{ user_id: string }[]>`
                    INSERT INTO users (
                        tenant_id, email, name, password_hash, role, status,
                        email_verified_at, signup_source
                    )
                    VALUES (
                        ${tenantId}, ${t.email}, ${t.name + ' Admin'}, ${PASSWORD_HASH},
                        'admin', 'active', now(), 'superadmin_onboard'
                    )
                    RETURNING user_id
                `
                const row = rows[0]
                if (!row) throw new Error(`Failed to insert admin user for ${t.name}`)
                userId = row.user_id
            }

            // ── 3. tenant_members link (modern multi-workspace model) ────
            await sql`
                INSERT INTO tenant_members (user_id, tenant_id, role)
                VALUES (${userId}, ${tenantId}, 'admin')
                ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'admin'
            `

            // ── 4. Set owner_user_id on personal tenants ─────────────────
            if (t.kind === 'personal') {
                await sql`
                    UPDATE tenants
                    SET owner_user_id = ${userId}
                    WHERE tenant_id = ${tenantId}
                `
            }

            // ── 5. Subscription (paid tiers only) ────────────────────────
            if (t.sub) {
                const subStart  = daysFromNow(t.sub.periodOffsetDays)
                const subEnd    = daysFromNow(t.sub.periodOffsetDays + 30)
                const subStatus = t.sub.status
                // Cancelled subs need cancel_at populated so the UI can show
                // "Access ends on …" and downstream cron logic stays sane.
                const cancelAt  = subStatus === 'cancelled' ? subEnd : null
                await sql`
                    INSERT INTO subscriptions (
                        tenant_id, plan_tier, billing_cycle, status,
                        current_period_start, current_period_end, cancel_at
                    )
                    VALUES (
                        ${tenantId}, ${t.planTier}, ${t.sub.billingCycle}, ${subStatus},
                        ${subStart}, ${subEnd}, ${cancelAt}
                    )
                    ON CONFLICT (tenant_id) DO UPDATE SET
                        plan_tier            = EXCLUDED.plan_tier,
                        billing_cycle        = EXCLUDED.billing_cycle,
                        status               = EXCLUDED.status,
                        current_period_start = EXCLUDED.current_period_start,
                        current_period_end   = EXCLUDED.current_period_end,
                        cancel_at            = EXCLUDED.cancel_at,
                        updated_at           = now()
                `
            }

            // ── 6. Billing period (for the usage gauge to render) ────────
            // Close any existing open period first, then open a fresh one
            // with the desired events_used / quota.
            await sql`
                UPDATE billing_periods
                SET closed_at = now()
                WHERE tenant_id = ${tenantId} AND closed_at IS NULL
            `

            const now = new Date()
            let periodStart: Date
            let periodEnd: Date
            if (t.planTier === 'trial') {
                // Trial billing period = the trial window (30 days total)
                const trialOffsetDays = t.trialOffset ?? 30
                periodStart = daysFromNow(trialOffsetDays - 30)
                periodEnd   = daysFromNow(trialOffsetDays)
            } else {
                // Paid/internal = calendar-monthly period
                periodStart = monthStart(now)
                periodEnd   = monthEnd(now)
            }
            const overageEvents = Math.max(0, t.usage.events - t.usage.quota)

            await sql`
                INSERT INTO billing_periods (
                    tenant_id, period_start, period_end, events_used, events_quota, overage_events
                )
                VALUES (
                    ${tenantId}, ${periodStart}, ${periodEnd},
                    ${t.usage.events}, ${t.usage.quota}, ${overageEvents}
                )
                ON CONFLICT (tenant_id, period_start) DO UPDATE SET
                    events_used    = EXCLUDED.events_used,
                    events_quota   = EXCLUDED.events_quota,
                    overage_events = EXCLUDED.overage_events,
                    closed_at      = NULL
            `

            // ── 7. Default SDK key (matches what self-signup auto-creates) ──
            // Without this, Settings → SDK Keys shows "No SDK keys found" for
            // the seeded tenant and there's no UI button to mint one.
            const hasSdkKey = await sql<{ key_id: string }[]>`
                SELECT key_id FROM sdk_keys WHERE tenant_id = ${tenantId} LIMIT 1
            `
            if (hasSdkKey.length === 0) {
                const { rawKey, keyHash, maskedKey } = generateSdkKey()
                await sql`
                    INSERT INTO sdk_keys (tenant_id, key_hash, masked_key, raw_key, name)
                    VALUES (${tenantId}, ${keyHash}, ${maskedKey}, ${rawKey}, 'default')
                `
            }

            console.log(`  ✓ ${t.name.padEnd(22)} — ${t.email}`)
        }

        // ── Summary ──────────────────────────────────────────────────────
        console.log('\n' + '─'.repeat(72))
        console.log('All 10 test tenants seeded. Log in with the email above + password:')
        console.log(`  ${PASSWORD}`)
        console.log('─'.repeat(72) + '\n')
        console.log('Test scenarios mapped to e2e_test_flows.md:')
        console.log('  Internal Test           → Flow 11 (comp account, perpetual)')
        console.log('  Trial Day 1             → Flow 1, 2, 5, 12 (baseline trial — no banner)')
        console.log('  Trial Day 28            → Flow 2 day-28 milestone (amber banner)')
        console.log('  Trial Readonly          → Flow 17 — trial ended, account in read-only')
        console.log('  Trial Suspended         → Flow 18 — hard-lock screen, 30 days from deletion')
        console.log('  Pro at 80% Quota        → Flow 3, 10 (QuotaBanner amber + 80% nudge)')
        console.log('  Pro Past Due            → Flow 19 (NEW) — payment failed, dark-red PastDueBanner')
        console.log('  Pro Cancelled Recent    → Flow 20 (NEW) — 700 days of readonly remaining')
        console.log('  Pro Cancelled Long Ago  → Flow 21 (NEW) — 30 days until auto-suspend')
        console.log('  Pro Suspended           → Flow 22 (NEW) — hard-locked, 30d from data wipe')
        console.log('')
        console.log('To rebuild from scratch:  pnpm tsx scripts/seed_test_tenants.ts --reset\n')
    } finally {
        await sql.end()
    }
}

main().catch((err) => {
    console.error('seed_test_tenants failed:', err)
    process.exit(1)
})
