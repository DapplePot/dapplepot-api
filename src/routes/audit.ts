import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole, requireOrganizationTenant } from '../middleware/authorize.js'
import { requireFeature } from '../middleware/planFeature.js'
import { rateLimitMiddleware } from '../middleware/ratelimit.js'
import { listAuditArchives, getAuditArchive, findSealedArchiveForPeriod } from '../queries/audit.pg.js'
import { sealMonthlyArchive, generateLiveReport, generateSessionReport } from '../lib/audit-generator.js'
import { downloadAuditArchive } from '../lib/gcs.js'
import { NotFoundError } from '../types/common.js'

type Variables = { tenantId: string; userId: string; role: string }

export const auditRouter = new Hono<{ Variables: Variables }>()

auditRouter.use('*', jwtAuth)
auditRouter.use('*', rateLimitMiddleware)
auditRouter.use('*', requireRole('admin'))
auditRouter.use('*', requireOrganizationTenant())
auditRouter.use('*', requireFeature('canExportSealedAudit'))

// GET /v1/audit/archives — list sealed monthly archives
auditRouter.get('/archives', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.query('agentId') ?? null
  const archives = await listAuditArchives(tenantId, agentId)
  return c.json({ data: archives })
})

// GET /v1/audit/archives/:id — download a sealed archive
auditRouter.get('/archives/:id', async (c) => {
  const tenantId  = c.get('tenantId')
  const archiveId = c.req.param('id')
  const archive   = await getAuditArchive(tenantId, archiveId)

  if (!archive) throw new NotFoundError(`Archive ${archiveId} not found`)
  if (archive.status !== 'sealed' || !archive.s3Key) {
    return c.json({ error: { code: 'NOT_READY', message: 'Archive is not yet sealed' } }, 409)
  }

  const body     = await downloadAuditArchive(archive.s3Key)
  const filename = `audit-${archive.periodStart.slice(0, 7)}-${archiveId.slice(0, 8)}.json`
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', 'application/json')
  c.header('Cache-Control', 'private, max-age=3600')
  return c.text(body)
})

// POST /v1/audit/archives/seal — trigger monthly archive generation
auditRouter.post('/archives/seal', async (c) => {
  const tenantId = c.get('tenantId')
  const body     = await c.req.json().catch(() => ({}))

  const parsed = z.object({
    year:    z.number().int().min(2020).max(2100),
    month:   z.number().int().min(1).max(12),
    agentId: z.string().uuid().nullable().optional(),
  }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  const { year, month, agentId = null } = parsed.data
  const periodStart = new Date(Date.UTC(year, month - 1, 1)).toISOString()
  const periodEnd   = new Date(Date.UTC(year, month, 1)).toISOString()

  const existing = await findSealedArchiveForPeriod({ tenantId, agentId: agentId ?? null, periodStart, periodEnd })
  if (existing) {
    return c.json({ archiveId: existing }, 200)
  }

  const { archiveId } = await sealMonthlyArchive({
    tenantId,
    agentId:     agentId ?? null,
    periodStart,
    periodEnd,
  })

  return c.json({ archiveId }, 201)
})

// GET /v1/audit/live — live gap report from last sealed archive to now
auditRouter.get('/live', async (c) => {
  const tenantId = c.get('tenantId')
  const agentId  = c.req.query('agentId') ?? null
  const report   = await generateLiveReport({ tenantId, agentId })

  const filename = `audit-live-${new Date().toISOString().slice(0, 10)}.json`
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', 'application/json')
  c.header('Cache-Control', 'no-store')
  return c.text(JSON.stringify(report, null, 2))
})

// GET /v1/audit/sessions/:sessionId — per-session audit report
auditRouter.get('/sessions/:sessionId', async (c) => {
  const tenantId  = c.get('tenantId')
  const sessionId = c.req.param('sessionId')
  const report    = await generateSessionReport({ tenantId, sessionId })

  const filename = `audit-session-${sessionId.slice(0, 8)}.json`
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', 'application/json')
  c.header('Cache-Control', 'no-store')
  return c.text(JSON.stringify(report, null, 2))
})
