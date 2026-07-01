/**
 * In-app upgrade requests (pre-Stripe self-serve upgrade requests routed for
 * manual fulfillment). Listed in the Superadmin Dashboard for triage.
 */

import { queryRow, queryRows } from '../lib/postgres.js'
import type { PlanTier } from '../lib/planLimits.js'

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

export interface UpgradeRequest {
    requestId:           string
    tenantId:            string
    requestedByUserId:   string
    currentPlanTier:     PlanTier
    requestedPlanTier:   'pro' | 'team' | 'enterprise'
    billingCycle:        'monthly' | 'annual'
    trigger:             string | null
    note:                string | null
    status:              'pending' | 'fulfilled' | 'rejected' | 'cancelled'
    fulfilledAt:         string | null
    fulfilledByUserId:   string | null
    createdAt:           string
}

interface UpgradeRequestRow {
    request_id:             string
    tenant_id:              string
    requested_by_user_id:   string
    current_plan_tier:      PlanTier
    requested_plan_tier:    'pro' | 'team' | 'enterprise'
    billing_cycle:          'monthly' | 'annual'
    trigger:                string | null
    note:                   string | null
    status:                 UpgradeRequest['status']
    fulfilled_at:           Date | string | null
    fulfilled_by_user_id:   string | null
    created_at:             Date | string
    [k: string]: unknown
}

function mapUpgradeReq(r: UpgradeRequestRow): UpgradeRequest {
    return {
        requestId:         r.request_id,
        tenantId:          r.tenant_id,
        requestedByUserId: r.requested_by_user_id,
        currentPlanTier:   r.current_plan_tier,
        requestedPlanTier: r.requested_plan_tier,
        billingCycle:      r.billing_cycle,
        trigger:           r.trigger,
        note:              r.note,
        status:            r.status,
        fulfilledAt:       r.fulfilled_at ? toIso(r.fulfilled_at) : null,
        fulfilledByUserId: r.fulfilled_by_user_id,
        createdAt:         toIso(r.created_at),
    }
}

export async function createUpgradeRequest(params: {
    tenantId:          string
    requestedByUserId: string
    currentPlanTier:   PlanTier
    requestedPlanTier: 'pro' | 'team' | 'enterprise'
    billingCycle:      'monthly' | 'annual'
    trigger?:          string
    note?:             string
}): Promise<UpgradeRequest> {
    const row = await queryRow<UpgradeRequestRow>(
        `INSERT INTO upgrade_requests
            (tenant_id, requested_by_user_id, current_plan_tier,
             requested_plan_tier, billing_cycle, trigger, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
            params.tenantId, params.requestedByUserId,
            params.currentPlanTier, params.requestedPlanTier, params.billingCycle,
            params.trigger ?? null, params.note ?? null,
        ]
    )
    if (!row) throw new Error('Failed to create upgrade request')
    return mapUpgradeReq(row)
}

export async function listUpgradeRequests(status?: UpgradeRequest['status']): Promise<UpgradeRequest[]> {
    const rows = status
        ? await queryRows<UpgradeRequestRow>(
            `SELECT * FROM upgrade_requests WHERE status = $1 ORDER BY created_at DESC LIMIT 200`,
            [status])
        : await queryRows<UpgradeRequestRow>(
            `SELECT * FROM upgrade_requests ORDER BY created_at DESC LIMIT 200`)
    return rows.map(mapUpgradeReq)
}
