/**
 * /v1/billing/* — Lemon Squeezy-backed billing endpoints.
 *
 *   POST /v1/billing/checkout-session  — start a hosted LS checkout
 *   POST /v1/billing/customer-portal   — get the customer's LS portal URL
 *   POST /v1/billing/webhook           — receive subscription lifecycle events
 *   GET  /v1/billing/invoices          — list invoices for the current tenant
 *
 * Same URL surface as the prior Stripe implementation so the UI keeps working.
 * Future Razorpay traffic for India will route to a sibling handler chosen
 * by customer country — but for v1 everything goes through LS.
 *
 * The webhook endpoint must be excluded from JSON body parsing because
 * signature verification needs the raw body bytes.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { env } from '../env.js'
import {
    createCheckoutSession as lsCreateCheckout,
    getCustomerPortalUrl,
    verifyWebhookSignature,
    planFromVariantId,
    fetchInvoicesForSubscription,
    persistCustomerId,
    LemonSqueezyNotConfiguredError,
} from '../lib/lemonsqueezy.js'
import { queryRow } from '../lib/postgres.js'
import { createPersonalWorkspaceForUser } from '../queries/tenants.pg.js'
import { generateAccessToken } from '../lib/auth-tokens.js'

type Variables = { tenantId: string; userId: string; role: string }

export const billingRouter = new Hono<{ Variables: Variables }>()

const APP_URL = env.DAPPLEPOT_APP_URL

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/billing/checkout-session
// ─────────────────────────────────────────────────────────────────────────────

const CheckoutBodySchema = z.object({
    planTier:     z.enum(['pro', 'team']),
    billingCycle: z.enum(['monthly', 'annual']),
})

billingRouter.post('/checkout-session', jwtAuth, async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch {
        return c.json({ error: { code: 'BAD_REQUEST' } }, 400)
    }
    const parsed = CheckoutBodySchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.errors[0]?.message } }, 400)
    }

    let   tenantId = c.get('tenantId')
    const userId   = c.get('userId')

    const user = await queryRow<{ email: string; name: string }>(
        `SELECT email, name FROM users WHERE user_id = $1`, [userId]
    )
    if (!user) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    // Orphan-user branch: caller has no active workspace (deleted their solo
    // workspace previously). Spin up a fresh personal workspace so LS Checkout
    // has a tenant to attach the subscription to. The webhook will then flip
    // plan_tier on this fresh tenant when payment succeeds.
    let issuedToken: string | null = null
    if (!tenantId) {
        const created = await createPersonalWorkspaceForUser({
            userId,
            userName: user.name || 'workspace',
        })
        await queryRow(
            `UPDATE users SET tenant_id = $1, role = 'admin', updated_at = now()
             WHERE user_id = $2`,
            [created.tenantId, userId]
        )
        tenantId = created.tenantId
        issuedToken = generateAccessToken({ userId, tenantId, role: 'admin' })
    }

    const tenant = await queryRow<{ name: string }>(
        `SELECT name FROM tenants WHERE tenant_id = $1`, [tenantId]
    )
    if (!tenant) return c.json({ error: { code: 'NOT_FOUND' } }, 404)

    try {
        // Redirect back to root with a marker. The OnboardingGate reads
        // ?checkout=success and flips the modal into a "payment received,
        // activating…" state instead of bouncing the user through an extra
        // /billing/success page.
        const { url, sessionId } = await lsCreateCheckout({
            tenantId,
            tenantName: tenant.name,
            ownerEmail: user.email,
            plan:       parsed.data.planTier,
            cycle:      parsed.data.billingCycle,
            successUrl: `${APP_URL}/?checkout=success`,
        })
        return c.json({ url, sessionId, accessToken: issuedToken })
    } catch (err) {
        if (err instanceof LemonSqueezyNotConfiguredError) {
            return c.json({ error: { code: 'BILLING_NOT_CONFIGURED', message: err.message } }, 503)
        }
        const msg = err instanceof Error ? err.message : 'Checkout failed'
        return c.json({ error: { code: 'BILLING_ERROR', message: msg } }, 500)
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/billing/customer-portal — manage subscription (cancel, update card)
// ─────────────────────────────────────────────────────────────────────────────

billingRouter.post('/customer-portal', jwtAuth, async (c) => {
    const tenantId = c.get('tenantId')
    const row = await queryRow<{ external_customer_id: string | null }>(
        `SELECT external_customer_id FROM tenants WHERE tenant_id = $1`, [tenantId]
    )
    if (!row?.external_customer_id) {
        return c.json({ error: { code: 'NO_BILLING_CUSTOMER', message: 'No billing customer yet — upgrade first.' } }, 400)
    }
    try {
        const url = await getCustomerPortalUrl(row.external_customer_id)
        return c.json({ url })
    } catch (err) {
        if (err instanceof LemonSqueezyNotConfiguredError) {
            return c.json({ error: { code: 'BILLING_NOT_CONFIGURED' } }, 503)
        }
        return c.json({ error: { code: 'BILLING_ERROR', message: (err as Error).message } }, 500)
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/billing/invoices
// ─────────────────────────────────────────────────────────────────────────────

billingRouter.get('/invoices', jwtAuth, async (c) => {
    const tenantId = c.get('tenantId')
    const sub = await queryRow<{ external_subscription_id: string | null }>(
        `SELECT external_subscription_id FROM subscriptions WHERE tenant_id = $1`, [tenantId]
    )
    if (!sub?.external_subscription_id) return c.json({ data: [] })

    try {
        const invoices = await fetchInvoicesForSubscription(sub.external_subscription_id)
        return c.json({
            data: invoices.map((inv: any) => ({
                id:          String(inv.id),
                number:      inv.attributes?.invoice_number ?? null,
                status:      inv.attributes?.status ?? null,
                amountPaid:  inv.attributes?.total ?? 0,
                currency:    inv.attributes?.currency ?? 'USD',
                createdAt:   inv.attributes?.created_at ?? null,
                periodStart: inv.attributes?.created_at ?? null,
                periodEnd:   inv.attributes?.created_at ?? null,
                hostedUrl:   inv.attributes?.urls?.invoice_url ?? null,
                pdfUrl:      inv.attributes?.urls?.invoice_url ?? null,
            })),
        })
    } catch (err) {
        if (err instanceof LemonSqueezyNotConfiguredError) return c.json({ data: [] })
        return c.json({ error: { code: 'BILLING_ERROR', message: (err as Error).message } }, 500)
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/billing/webhook — LS subscription lifecycle events
// ─────────────────────────────────────────────────────────────────────────────

billingRouter.post('/webhook', async (c) => {
    const sig = c.req.header('x-signature')
    if (!sig) return c.json({ error: 'missing signature' }, 400)

    const rawBody = await c.req.text()
    if (!verifyWebhookSignature(rawBody, sig)) {
        console.error('[ls webhook] signature failed')
        return c.json({ error: 'invalid signature' }, 400)
    }

    let event: { meta: { event_name: string; custom_data?: Record<string, string> }; data: any }
    try {
        event = JSON.parse(rawBody)
    } catch {
        return c.json({ error: 'invalid json' }, 400)
    }

    const eventName = event.meta?.event_name
    const subscriptionData = event.data
    const customData = event.meta?.custom_data ?? {}

    try {
        switch (eventName) {
            case 'subscription_created':
            case 'subscription_resumed':
            case 'subscription_unpaused':
                await handleSubscriptionActivated(subscriptionData, customData)
                break

            case 'subscription_updated':
                await handleSubscriptionUpdated(subscriptionData, customData)
                break

            case 'subscription_payment_success':
            case 'subscription_payment_recovered':
                await handlePaymentSuccess(subscriptionData, customData)
                break

            case 'subscription_payment_failed':
                await handlePaymentFailed(subscriptionData, customData)
                break

            case 'subscription_cancelled':
            case 'subscription_expired':
            case 'subscription_paused':
                await handleSubscriptionEnded(subscriptionData, customData)
                break

            default:
                // Unknown events ack with 2xx so LS doesn't retry forever.
                break
        }
        return c.json({ received: true })
    } catch (err) {
        console.error('[ls webhook]', eventName, 'handler failed:', (err as Error).message)
        return c.json({ error: 'handler failed' }, 500)
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// Webhook handlers
// ─────────────────────────────────────────────────────────────────────────────

function attrs(data: any) {
    return data?.attributes ?? {}
}

function customTenantId(custom: Record<string, string>, data: any): string | null {
    return custom?.tenant_id
        ?? attrs(data)?.first_subscription_item?.custom_data?.tenant_id
        ?? null
}

async function handleSubscriptionActivated(data: any, custom: Record<string, string>): Promise<void> {
    const tenantId = customTenantId(custom, data)
    if (!tenantId) {
        console.warn('[ls webhook] subscription_created without tenant_id')
        return
    }
    const a = attrs(data)
    const variantId  = a.variant_id
    const planMap    = variantId ? planFromVariantId(variantId) : null
    if (!planMap) {
        console.warn('[ls webhook] unknown variant in subscription:', variantId)
        return
    }
    const customerId = a.customer_id
    if (customerId) await persistCustomerId(tenantId, customerId)

    await upsertSubscription({
        tenantId,
        plan:               planMap.plan,
        cycle:              planMap.cycle,
        status:             mapLsStatus(a.status),
        externalSubId:      String(data.id),
        externalCustomerId: String(customerId),
        renewsAt:           a.renews_at,
    })

    // Team / Enterprise are multi-seat — if this tenant was a personal workspace
    // (typical for self-signup customers upgrading from Free Trial), promote it
    // to an organization so the multi-user UX (invites, Users tab, RBAC) lights up.
    // Pro stays personal — Pro is single-seat by design.
    const promotesToOrg = planMap.plan === 'team'

    // owner_user_id — stable pointer to the person who pays/runs the workspace.
    // If already set (older tenant), preserve it. Otherwise grab the current
    // admin (the person who clicked "Buy") and stamp it. Owners get protection
    // against being removed or demoted by other admins (enforced at API layer).
    await queryRow(
        `UPDATE tenants
         SET plan_tier               = $2,
             plan_changed_at         = now(),
             onboarding_completed_at = COALESCE(onboarding_completed_at, now()),
             trial_ends_at           = NULL,
             kind                    = CASE WHEN $3::boolean THEN 'organization' ELSE kind END,
             owner_user_id           = COALESCE(
                 owner_user_id,
                 (SELECT user_id FROM users
                  WHERE tenant_id = $1 AND role = 'admin' AND status = 'active'
                  ORDER BY created_at ASC
                  LIMIT 1)
             ),
             lifecycle_state         = 'active',
             updated_at              = now()
         WHERE tenant_id = $1`,
        [tenantId, planMap.plan, promotesToOrg]
    )
}

async function handleSubscriptionUpdated(data: any, custom: Record<string, string>): Promise<void> {
    const tenantId = customTenantId(custom, data)
    if (!tenantId) return
    const a = attrs(data)
    const variantId = a.variant_id
    const planMap = variantId ? planFromVariantId(variantId) : null
    if (!planMap) return

    await upsertSubscription({
        tenantId,
        plan:               planMap.plan,
        cycle:              planMap.cycle,
        status:             mapLsStatus(a.status),
        externalSubId:      String(data.id),
        externalCustomerId: String(a.customer_id),
        renewsAt:           a.renews_at,
    })
    await queryRow(
        `UPDATE tenants
         SET plan_tier       = $2,
             plan_changed_at = now(),
             updated_at      = now()
         WHERE tenant_id = $1`,
        [tenantId, planMap.plan]
    )
}

async function handlePaymentSuccess(data: any, _custom: Record<string, string>): Promise<void> {
    // LS payment_success events arrive under a subscription_invoice payload —
    // grab the subscription_id from the invoice and bump status to active.
    const a = attrs(data)
    const subscriptionId = a.subscription_id
    if (!subscriptionId) return
    await queryRow(
        `UPDATE subscriptions
         SET status     = 'active',
             updated_at = now()
         WHERE external_subscription_id = $1 AND billing_provider = 'lemonsqueezy'`,
        [String(subscriptionId)]
    )
    // Restore tenant to active state — payment recovered, lift the read-only lock.
    // Only restore if currently readonly; never touch already-active or further-along states.
    await queryRow(
        `UPDATE tenants
         SET lifecycle_state      = 'active',
             lifecycle_changed_at = now(),
             updated_at           = now()
         WHERE tenant_id = (
            SELECT tenant_id FROM subscriptions
            WHERE external_subscription_id = $1 AND billing_provider = 'lemonsqueezy'
         )
         AND lifecycle_state = 'readonly'`,
        [String(subscriptionId)]
    )
}

async function handlePaymentFailed(data: any, _custom: Record<string, string>): Promise<void> {
    const a = attrs(data)
    const subscriptionId = a.subscription_id ?? data.id
    if (!subscriptionId) return
    await queryRow(
        `UPDATE subscriptions
         SET status     = 'past_due',
             updated_at = now()
         WHERE external_subscription_id = $1 AND billing_provider = 'lemonsqueezy'`,
        [String(subscriptionId)]
    )
    // Block writes — tenant goes read-only until they update their card.
    // We deliberately do NOT touch lifecycle_changed_at; the daily cron skips
    // paid tenants whose subscription.status is 'past_due' (not 'cancelled'),
    // so this state persists indefinitely (no auto-decay).
    await queryRow(
        `UPDATE tenants
         SET lifecycle_state = 'readonly',
             updated_at      = now()
         WHERE tenant_id = (
            SELECT tenant_id FROM subscriptions
            WHERE external_subscription_id = $1 AND billing_provider = 'lemonsqueezy'
         )
         AND lifecycle_state = 'active'`,
        [String(subscriptionId)]
    )
}

async function handleSubscriptionEnded(data: any, custom: Record<string, string>): Promise<void> {
    const tenantId = customTenantId(custom, data)
    if (!tenantId) return

    const a = attrs(data)
    // Anchor the 2-year readonly window to the last paid period end so the
    // clock starts when the customer's paid coverage actually ends, not now.
    // If LS doesn't provide renews_at (paused/expired flows), fall back to now.
    const lastPaidEnd: string = a.renews_at ?? a.ends_at ?? new Date().toISOString()

    await queryRow(
        `UPDATE subscriptions
         SET status     = 'cancelled',
             cancel_at  = now(),
             updated_at = now()
         WHERE external_subscription_id = $1 AND billing_provider = 'lemonsqueezy'`,
        [String(data.id)]
    )
    // Move into readonly state anchored to the last paid date. The plan_tier
    // is preserved (pro/team/enterprise) so the per-tier readonlyDays (730)
    // controls when the cron promotes them to suspended.
    await queryRow(
        `UPDATE tenants
         SET lifecycle_state      = 'readonly',
             lifecycle_changed_at = $2,
             updated_at           = now()
         WHERE tenant_id = $1`,
        [tenantId, lastPaidEnd]
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface UpsertSubArgs {
    tenantId:           string
    plan:               'pro' | 'team'
    cycle:              'monthly' | 'annual'
    status:             'active' | 'past_due' | 'cancelled' | 'paused'
    externalSubId:      string
    externalCustomerId: string
    renewsAt:           string | null
}

async function upsertSubscription(args: UpsertSubArgs): Promise<void> {
    const currentPeriodEnd = args.renewsAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString()
    await queryRow(
        `INSERT INTO subscriptions (
            tenant_id, plan_tier, billing_cycle, status, billing_provider,
            current_period_start, current_period_end,
            external_subscription_id, external_customer_id
         )
         VALUES (
            $1, $2, $3, $4, 'lemonsqueezy',
            now(), $5,
            $6, $7
         )
         ON CONFLICT (tenant_id) DO UPDATE SET
            plan_tier                = EXCLUDED.plan_tier,
            billing_cycle            = EXCLUDED.billing_cycle,
            status                   = EXCLUDED.status,
            billing_provider         = EXCLUDED.billing_provider,
            current_period_end       = EXCLUDED.current_period_end,
            external_subscription_id = EXCLUDED.external_subscription_id,
            external_customer_id     = EXCLUDED.external_customer_id,
            updated_at               = now()`,
        [
            args.tenantId, args.plan, args.cycle, args.status,
            currentPeriodEnd,
            args.externalSubId, args.externalCustomerId,
        ]
    )
}

function mapLsStatus(s: string): 'active' | 'past_due' | 'cancelled' | 'paused' {
    if (s === 'active' || s === 'on_trial') return 'active'
    if (s === 'past_due' || s === 'unpaid') return 'past_due'
    if (s === 'cancelled' || s === 'expired') return 'cancelled'
    if (s === 'paused') return 'paused'
    return 'past_due'
}
