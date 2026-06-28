/**
 * /v1/leads/* — public endpoints (no auth) for Enterprise prospects.
 *
 * Submissions are visible to superadmins via /admin/leads (Phase 3 follow-up).
 * Rate-limited per IP to discourage spam; for v1 we accept the noise and
 * filter manually if needed.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { createEnterpriseLead } from '../queries/leads.pg.js'

export const leadsRouter = new Hono()

const ContactSalesSchema = z.object({
    name:                   z.string().min(1).max(200),
    email:                  z.string().email().max(200),
    company:                z.string().max(200).optional(),
    monthlyVolumeEstimate:  z.string().max(200).optional(),
    deploymentPreference:   z.enum(['saas', 'self_hosted_vpc']).optional(),
    complianceNeeds:        z.string().max(500).optional(),
    notes:                  z.string().max(2000).optional(),
})

leadsRouter.post('/contact-sales', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400)
    }
    const parsed = ContactSalesSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'Validation error' } }, 400)
    }
    try {
        const d = parsed.data
        const lead = await createEnterpriseLead({
            name:                  d.name!,
            email:                 d.email!,
            company:               d.company,
            monthlyVolumeEstimate: d.monthlyVolumeEstimate,
            deploymentPreference:  d.deploymentPreference,
            complianceNeeds:       d.complianceNeeds,
            notes:                 d.notes,
        })
        return c.json({ ok: true, leadId: lead.leadId }, 201)
    } catch (err) {
        return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500)
    }
})
