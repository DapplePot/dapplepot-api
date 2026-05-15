import { queryRow, queryRows } from '../lib/postgres.js'

export interface AuditArchiveMeta {
  archiveId:    string
  tenantId:     string
  agentId:      string | null
  periodStart:  string
  periodEnd:    string
  status:       'sealing' | 'sealed' | 'failed'
  sha256:       string | null
  s3Bucket:     string | null
  s3Key:        string | null
  sessionCount: number
  eventCount:   number
  findingCount: number
  alertCount:   number
  createdAt:    string
  sealedAt:     string | null
}

interface RawArchive extends Record<string, unknown> {
  archive_id:    string
  tenant_id:     string
  agent_id:      string | null
  period_start:  Date
  period_end:    Date
  status:        string
  sha256:        string | null
  s3_bucket:     string | null
  s3_key:        string | null
  session_count: number
  event_count:   number
  finding_count: number
  alert_count:   number
  created_at:    Date
  sealed_at:     Date | null
}

function mapMeta(r: RawArchive): AuditArchiveMeta {
  return {
    archiveId:    r.archive_id,
    tenantId:     r.tenant_id,
    agentId:      r.agent_id,
    periodStart:  r.period_start.toISOString(),
    periodEnd:    r.period_end.toISOString(),
    status:       r.status as AuditArchiveMeta['status'],
    sha256:       r.sha256,
    s3Bucket:     r.s3_bucket,
    s3Key:        r.s3_key,
    sessionCount: r.session_count,
    eventCount:   r.event_count,
    findingCount: r.finding_count,
    alertCount:   r.alert_count,
    createdAt:    r.created_at.toISOString(),
    sealedAt:     r.sealed_at?.toISOString() ?? null,
  }
}

const META_COLS = `archive_id, tenant_id, agent_id, period_start, period_end,
                   status, sha256, s3_bucket, s3_key,
                   session_count, event_count, finding_count, alert_count,
                   created_at, sealed_at`

export async function listAuditArchives(
  tenantId: string,
  agentId?: string | null
): Promise<AuditArchiveMeta[]> {
  const rows = await queryRows<RawArchive>(
    `SELECT ${META_COLS}
     FROM audit_archives
     WHERE tenant_id = $1::uuid
       AND ($2::uuid IS NULL OR agent_id = $2::uuid)
       AND status = 'sealed'
     ORDER BY period_start DESC`,
    [tenantId, agentId ?? null]
  )
  return rows.map(mapMeta)
}

export async function findSealedArchiveForPeriod(params: {
  tenantId:    string
  agentId:     string | null
  periodStart: string
  periodEnd:   string
}): Promise<string | null> {
  const row = await queryRow<{ archive_id: string }>(
    `SELECT archive_id FROM audit_archives
     WHERE tenant_id   = $1::uuid
       AND ($2::uuid IS NULL OR agent_id = $2::uuid)
       AND period_start = $3
       AND period_end   = $4
       AND status       = 'sealed'
     LIMIT 1`,
    [params.tenantId, params.agentId ?? null, params.periodStart, params.periodEnd]
  )
  return row?.archive_id ?? null
}

export async function getAuditArchive(
  tenantId: string,
  archiveId: string
): Promise<AuditArchiveMeta | undefined> {
  const row = await queryRow<RawArchive>(
    `SELECT ${META_COLS}
     FROM audit_archives
     WHERE archive_id = $1::uuid AND tenant_id = $2::uuid`,
    [archiveId, tenantId]
  )
  return row ? mapMeta(row) : undefined
}

export async function getLastSealedArchive(
  tenantId: string,
  agentId: string | null
): Promise<AuditArchiveMeta | undefined> {
  const row = await queryRow<RawArchive>(
    `SELECT ${META_COLS}
     FROM audit_archives
     WHERE tenant_id = $1::uuid
       AND ($2::uuid IS NULL OR agent_id = $2::uuid)
       AND status = 'sealed'
     ORDER BY period_end DESC
     LIMIT 1`,
    [tenantId, agentId ?? null]
  )
  return row ? mapMeta(row) : undefined
}

export async function createAuditArchive(params: {
  tenantId:    string
  agentId:     string | null
  periodStart: string
  periodEnd:   string
}): Promise<string> {
  const row = await queryRow<{ archive_id: string }>(
    `INSERT INTO audit_archives (tenant_id, agent_id, period_start, period_end, status)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'sealing')
     RETURNING archive_id`,
    [params.tenantId, params.agentId ?? null, params.periodStart, params.periodEnd]
  )
  if (!row) throw new Error('Failed to create audit archive row')
  return row.archive_id
}

export async function sealAuditArchive(params: {
  archiveId:    string
  tenantId:     string
  sha256:       string
  s3Bucket:     string
  s3Key:        string
  sessionCount: number
  eventCount:   number
  findingCount: number
  alertCount:   number
}): Promise<void> {
  await queryRow(
    `UPDATE audit_archives
     SET status        = 'sealed',
         sha256        = $3,
         s3_bucket     = $4,
         s3_key        = $5,
         session_count = $6,
         event_count   = $7,
         finding_count = $8,
         alert_count   = $9,
         sealed_at     = now()
     WHERE archive_id = $1::uuid AND tenant_id = $2::uuid`,
    [
      params.archiveId,
      params.tenantId,
      params.sha256,
      params.s3Bucket,
      params.s3Key,
      params.sessionCount,
      params.eventCount,
      params.findingCount,
      params.alertCount,
    ]
  )
}

export async function failAuditArchive(
  archiveId: string,
  tenantId:  string,
  message:   string
): Promise<void> {
  await queryRow(
    `UPDATE audit_archives
     SET status = 'failed', error_message = $3
     WHERE archive_id = $1::uuid AND tenant_id = $2::uuid`,
    [archiveId, tenantId, message]
  )
}
