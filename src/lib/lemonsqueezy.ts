/**
 * Lemon Squeezy client + helpers.
 *
 * LS is configured via @lemonsqueezy/lemonsqueezy.js using a single API key.
 * All LS-specific code lives here. A future Razorpay integration will live
 * in a sibling file `razorpay.ts` and `routes/billing.ts` will route to the
 * right one based on the customer's country / pricing preference.
 *
 * Install once: `pnpm add @lemonsqueezy/lemonsqueezy.js`
 */

import {
    lemonSqueezySetup,
    createCheckout,
    getCustomer,
    getSubscription,
    listSubscriptionInvoices,
} from '@lemonsqueezy/lemonsqueezy.js'
import { env } from '../env.js'
import { queryRow } from './postgres.js'
import crypto from 'crypto'

let _configured = false

/** Lazy setup. Call before any LS API call. Throws if not configured. */
function ensureConfigured(): void {
    if (_configured) return
    if (!env.LEMONSQUEEZY_API_KEY) throw new LemonSqueezyNotConfiguredError()
    lemonSqueezySetup({ apiKey: env.LEMONSQUEEZY_API_KEY })
    _configured = true
}

export class LemonSqueezyNotConfiguredError extends Error {
    constructor() {
        super('BILLING_NOT_CONFIGURED — set LEMONSQUEEZY_API_KEY in .env to enable billing.')
        this.name = 'LemonSqueezyNotConfiguredError'
    }
}

export function webhookSecret(): string | null {
    return env.LEMONSQUEEZY_WEBHOOK_SECRET ?? null
}

export function storeId(): string {
    if (!env.LEMONSQUEEZY_STORE_ID) throw new Error('LEMONSQUEEZY_STORE_ID missing in env')
    return env.LEMONSQUEEZY_STORE_ID
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant ID lookup — maps (plan_tier, billing_cycle) → LS variant ID
// ─────────────────────────────────────────────────────────────────────────────

export type PlanForCheckout = 'pro' | 'team'
export type BillingCycle    = 'monthly' | 'annual'

export function variantIdFor(plan: PlanForCheckout, cycle: BillingCycle): string {
    const map: Record<`${PlanForCheckout}_${BillingCycle}`, string | undefined> = {
        pro_monthly:  env.LEMONSQUEEZY_VARIANT_PRO_MONTHLY,
        pro_annual:   env.LEMONSQUEEZY_VARIANT_PRO_ANNUAL,
        team_monthly: env.LEMONSQUEEZY_VARIANT_TEAM_MONTHLY,
        team_annual:  env.LEMONSQUEEZY_VARIANT_TEAM_ANNUAL,
    }
    const id = map[`${plan}_${cycle}`]
    if (!id) {
        throw new Error(
            `Missing LEMONSQUEEZY_VARIANT_${plan.toUpperCase()}_${cycle.toUpperCase()} in env — ` +
            `create the variant in your Lemon Squeezy dashboard and paste its ID into .env.`
        )
    }
    return id
}

/** Reverse lookup from a Lemon Squeezy variant ID → (plan, cycle). Used by webhooks. */
export function planFromVariantId(variantId: string | number): { plan: PlanForCheckout; cycle: BillingCycle } | null {
    const v = String(variantId)
    const matchers: { id: string | undefined; plan: PlanForCheckout; cycle: BillingCycle }[] = [
        { id: env.LEMONSQUEEZY_VARIANT_PRO_MONTHLY,  plan: 'pro',  cycle: 'monthly' },
        { id: env.LEMONSQUEEZY_VARIANT_PRO_ANNUAL,   plan: 'pro',  cycle: 'annual'  },
        { id: env.LEMONSQUEEZY_VARIANT_TEAM_MONTHLY, plan: 'team', cycle: 'monthly' },
        { id: env.LEMONSQUEEZY_VARIANT_TEAM_ANNUAL,  plan: 'team', cycle: 'annual'  },
    ]
    return matchers.find(m => m.id === v) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook signature verification (HMAC-SHA256)
// ─────────────────────────────────────────────────────────────────────────────

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = webhookSecret()
    if (!secret) return false
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout
// ─────────────────────────────────────────────────────────────────────────────

export async function createCheckoutSession(params: {
    tenantId:     string
    tenantName:   string
    ownerEmail:   string
    plan:         PlanForCheckout
    cycle:        BillingCycle
    successUrl:   string
}): Promise<{ url: string; sessionId: string }> {
    ensureConfigured()
    const variantId = variantIdFor(params.plan, params.cycle)

    const { data, error } = await createCheckout(storeId(), variantId, {
        productOptions: {
            redirectUrl: params.successUrl,
        },
        checkoutData: {
            email: params.ownerEmail,
            name:  params.tenantName,
            custom: {
                tenant_id:    params.tenantId,
                plan_tier:    params.plan,
                billing_cycle: params.cycle,
            },
        },
        checkoutOptions: {
            embed: false,
        },
        preview: false,
    })
    if (error || !data) throw new Error(`Lemon Squeezy checkout creation failed: ${error?.message ?? 'unknown error'}`)

    return {
        url:       data.data.attributes.url,
        sessionId: String(data.data.id),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer portal — LS provides a per-customer hosted portal URL
// ─────────────────────────────────────────────────────────────────────────────

export async function getCustomerPortalUrl(customerId: string): Promise<string> {
    ensureConfigured()
    const { data, error } = await getCustomer(customerId)
    if (error || !data) throw new Error(`Lemon Squeezy customer fetch failed: ${error?.message ?? 'unknown error'}`)
    const url = data.data.attributes.urls?.customer_portal
    if (!url) throw new Error('LS customer has no customer_portal URL')
    return url
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions + invoices (read-only for the UI)
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchSubscription(subscriptionId: string) {
    ensureConfigured()
    const { data, error } = await getSubscription(subscriptionId)
    if (error || !data) throw new Error(`LS subscription fetch failed: ${error?.message}`)
    return data.data
}

export async function fetchInvoicesForSubscription(subscriptionId: string) {
    ensureConfigured()
    const { data, error } = await listSubscriptionInvoices({ filter: { subscriptionId } })
    if (error || !data) return []
    return data.data
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-side persistence helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist the LS customer ID on the tenant the first time we see it (from a
 * webhook). Idempotent — ON CONFLICT-style update guarded by an explicit
 * COALESCE so we don't overwrite a previously-stored value with NULL.
 */
export async function persistCustomerId(tenantId: string, customerId: string | number): Promise<void> {
    await queryRow(
        `UPDATE tenants
         SET external_customer_id = COALESCE(external_customer_id, $2),
             updated_at           = now()
         WHERE tenant_id = $1`,
        [tenantId, String(customerId)]
    )
}
