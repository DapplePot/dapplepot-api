/**
 * Enterprise leads (public Contact Sales form) + in-app upgrade requests
 * (pre-Stripe self-serve upgrade requests routed for manual fulfillment).
 *
 * Both surfaces are listed in the Superadmin Dashboard for triage.
 */

import { queryRow, queryRows } from '../lib/postgres.js'
import type { PlanTier } from '../lib/planLimits.js'

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

// ─────────────────────────────────────────────────────────────────────────────
// Enterprise leads
// ─────────────────────────────────────────────────────────────────────────────

export interface EnterpriseLead {
    leadId:                string
    name:                  string
    email:                 string
    company:               string | null
    monthlyVolumeEstimate: string | null
    deploymentPreference:  string | null
    complianceNeeds:       string | null
    notes:                 string | null
    status:                'new' | 'contacted' | 'qualified' | 'won' | 'lost'
    assignedToUserId:      string | null
    createdAt:             string
    updatedAt:             string
}

interface EnterpriseLeadRow {
    lead_id:                  string
    name:                     string
    email:                    string
    company:                  string | null
    monthly_volume_estimate:  string | null
    deployment_preference:    string | null
    compliance_needs:         string | null
    notes:                    string | null
    status:                   EnterpriseLead['status']
    assigned_to_user_id:      string | null
    created_at:               Date | string
    updated_at:               Date | string
    [k: string]: unknown
}

function mapLead(r: EnterpriseLeadRow): EnterpriseLead {
    return {
        leadId:                r.lead_id,
        name:                  r.name,
        email:                 r.email,
        company:               r.company,
        monthlyVolumeEstimate: r.monthly_volume_estimate,
        deploymentPreference:  r.deployment_preference,
        complianceNeeds:       r.compliance_needs,
        notes:                 r.notes,
        status:                r.status,
        assignedToUserId:      r.assigned_to_user_id,
        createdAt:             toIso(r.created_at),
        updatedAt:             toIso(r.updated_at),
    }
}

export async function createEnterpriseLead(params: {
    name:                   string
    email:                  string
    company?:               string
    monthlyVolumeEstimate?: string
    deploymentPreference?:  string
    complianceNeeds?:       string
    notes?:                 string
}): Promise<EnterpriseLead> {
    const row = await queryRow<EnterpriseLeadRow>(
        `INSERT INTO enterprise_leads
            (name, email, company, monthly_volume_estimate,
             deployment_preference, compliance_needs, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
            params.name, params.email,
            params.company ?? null,
            params.monthlyVolumeEstimate ?? null,
            params.deploymentPreference ?? null,
            params.complianceNeeds ?? null,
            params.notes ?? null,
        ]
    )
    if (!row) throw new Error('Failed to create lead')
    return mapLead(row)
}

export async function listEnterpriseLeads(status?: EnterpriseLead['status']): Promise<EnterpriseLead[]> {
    const rows = status
        ? await queryRows<EnterpriseLeadRow>(
            `SELECT * FROM enterprise_leads WHERE status = $1 ORDER BY created_at DESC LIMIT 200`,
            [status])
        : await queryRows<EnterpriseLeadRow>(
            `SELECT * FROM enterprise_leads ORDER BY created_at DESC LIMIT 200`)
    return rows.map(mapLead)
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade requests (pre-Stripe)
// ─────────────────────────────────────────────────────────────────────────────

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
