/**
 * Single source of truth for plan-tier limits and feature flags.
 *
 * Read by:
 *   - middleware/quotaCheck.ts        (event quota enforcement)
 *   - middleware/planFeature.ts       (feature gating)
 *   - routes/agents.ts                (agent count cap)
 *   - routes/users.ts (invite path)   (seat cap)
 *   - routes/channels.ts              (channel-type allowlist)
 *   - routes/me.ts (GET /me/plan)     (UI plan snapshot)
 *
 * Mirrored on the UI in dapplepot-ui/src/lib/planLimits.ts — the UI uses
 * these for cosmetic gating (hide buttons, show upgrade prompts). The
 * server is always the source of truth for enforcement.
 *
 * If you change anything here, update pricing_strategy.md to match.
 */

export type PlanTier = 'internal' | 'trial' | 'pro' | 'team' | 'enterprise'

export type ChannelType = 'slack' | 'msteams' | 'webhook' | 'pagerduty'

export interface PlanLimits {
    /** Max number of registered agents per tenant. null = unlimited. */
    maxAgents: number | null

    /**
     * Event quota per billing period.
     *   trial:      total over the 30-day window
     *   internal:   per calendar month
     *   pro/team:   per calendar month
     *   enterprise: from subscription override; null here = "use override"
     */
    eventsPerPeriod: number | null

    /** Max seats (users) in the tenant. null = unlimited. */
    maxSeats: number | null

    /** Days the trial runs before expiry. null = no trial timer. */
    trialDays: number | null

    /**
     * Days a trial tenant stays in read-only state after the trial ends.
     * After this window: lifecycle_state → 'suspended' (hard lock).
     * Only meaningful for plan_tier='trial'.
     */
    readonlyDays: number

    /**
     * Days a tenant stays in 'suspended' state before data is deleted.
     */
    suspendedDays: number

    /** Alert channel types this tier can configure (in-app is always on). */
    allowedChannels: readonly ChannelType[]

    /** Whether the tenant can issue workspace invites (multi-seat). */
    canInviteTeammates: boolean

    /** Whether the tenant can request / download sealed audit reports. */
    canExportSealedAudit: boolean

    /**
     * Whether overages on event quota are billed. Currently false for every
     * tier — all tenants hard-cap (429) at quota. Kept as a flag so we can
     * flip it back per-tier once metered billing is wired through
     * `routes/billing.ts` (today there's no path that actually charges).
     */
    overageBillable: boolean

    /** Whether the tier may be selected via the self-serve signup flow. */
    isSelfServe: boolean

    /** Customer-facing display name. */
    displayName: string
}

export const PLAN_LIMITS: Readonly<Record<PlanTier, PlanLimits>> = {
    internal: {
        // Comped accounts have no caps — they're for the founder team,
        // advisors, and trusted partners. No need to police usage.
        maxAgents:            null,
        eventsPerPeriod:      null,
        maxSeats:             null,
        trialDays:            null,
        readonlyDays:         0,
        suspendedDays:        0,
        allowedChannels:      [],
        canInviteTeammates:   false,
        canExportSealedAudit: false,
        overageBillable:      false,
        isSelfServe:          false,
        displayName:          'Internal',
    },

    trial: {
        maxAgents:            3,
        eventsPerPeriod:      10_000,
        maxSeats:             1,
        trialDays:            30,
        readonlyDays:         90,
        suspendedDays:        90,
        allowedChannels:      [],
        canInviteTeammates:   false,
        canExportSealedAudit: false,
        overageBillable:      false,
        isSelfServe:          true,
        displayName:          'Free Trial',
    },

    pro: {
        maxAgents:            null,
        eventsPerPeriod:      50_000,
        maxSeats:             1,
        trialDays:            null,
        // Post-cancellation retention: 2 years of read-only access from the
        // last paid period end, then 90 days suspended, then deletion. Lets
        // churned customers return up to ~27 months later with data intact.
        readonlyDays:         730,
        suspendedDays:        90,
        allowedChannels:      [],
        canInviteTeammates:   false,
        canExportSealedAudit: false,
        overageBillable:      false,
        isSelfServe:          true,
        displayName:          'Pro',
    },

    team: {
        maxAgents:            null,
        eventsPerPeriod:      350_000,
        maxSeats:             5,
        trialDays:            null,
        readonlyDays:         730,
        suspendedDays:        90,
        allowedChannels:      ['slack', 'msteams', 'webhook'],
        canInviteTeammates:   true,
        canExportSealedAudit: false,
        overageBillable:      false,
        isSelfServe:          true,
        displayName:          'Team',
    },

    enterprise: {
        maxAgents:            null,
        eventsPerPeriod:      null,       // Subscription-overridden
        maxSeats:             null,
        trialDays:            null,
        // Same 2-year retention as Pro/Team. Enterprise MSAs may specify a
        // different retention period — superadmin can manually extend per-tenant.
        readonlyDays:         730,
        suspendedDays:        90,
        allowedChannels:      ['slack', 'msteams', 'webhook', 'pagerduty'],
        canInviteTeammates:   true,
        canExportSealedAudit: true,
        overageBillable:      false,
        isSelfServe:          false,
        displayName:          'Enterprise',
    },
}

/**
 * Pure lookup — no DB hit. Use this when you only need the tier's limits
 * and already know the plan_tier value.
 */
export function getPlanLimits(plan: PlanTier): PlanLimits {
    return PLAN_LIMITS[plan]
}

/** Billing-cycle prices in USD (matches pricing_strategy.md §4). */
export const PLAN_PRICES_USD: Readonly<Record<'pro' | 'team', { monthly: number; annual: number }>> = {
    pro:  { monthly: 20,  annual: 200   },
    team: { monthly: 150, annual: 1_500 },
}
