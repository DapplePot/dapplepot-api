import { queryRows } from './postgres.js'
import { sealMonthlyArchive } from './audit-generator.js'

// Personal workspaces are single-user dev sandboxes — they don't get audit
// archives, so the seal job skips them.
async function getActiveTenantIds(): Promise<string[]> {
  const rows = await queryRows<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenants WHERE enabled = true AND kind = 'organization'`
  )
  return rows.map(r => r.tenant_id)
}

async function sealPreviousMonth(): Promise<void> {
  const now   = new Date()
  const year  = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()

  console.log(`[audit-seal] Starting monthly seal for ${year}-${String(month).padStart(2, '0')}`)

  const tenantIds = await getActiveTenantIds()
  console.log(`[audit-seal] ${tenantIds.length} active tenant(s)`)

  const periodStart = new Date(Date.UTC(year, month - 1, 1)).toISOString()
  const periodEnd   = new Date(Date.UTC(year, month, 1)).toISOString()

  for (const tenantId of tenantIds) {
    try {
      const { archiveId } = await sealMonthlyArchive({ tenantId, agentId: null, periodStart, periodEnd })
      console.log(`[audit-seal] tenant=${tenantId} → archive=${archiveId}`)
    } catch (err) {
      console.error(`[audit-seal] tenant=${tenantId} failed:`, err)
    }
  }

  console.log(`[audit-seal] Done for ${year}-${String(month).padStart(2, '0')}`)
}

function msUntilNextFirstOfMonth(): number {
  const now  = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return next.getTime() - now.getTime()
}

const MAX_SAFE_TIMEOUT = 2_147_483_647 // Node setTimeout max (32-bit signed int, ~24.8 days)

function scheduleMonthlyRun(): void {
  const ms = msUntilNextFirstOfMonth()
  const nextRun = new Date(Date.now() + ms).toISOString()
  console.log(`[audit-seal] Next run scheduled for ${nextRun} (in ${Math.round(ms / 3600000)}h)`)

  if (ms > MAX_SAFE_TIMEOUT) {
    setTimeout(() => scheduleMonthlyRun(), MAX_SAFE_TIMEOUT)
    return
  }

  setTimeout(async () => {
    await sealPreviousMonth().catch(err => console.error('[audit-seal] Unhandled error:', err))
    scheduleMonthlyRun()
  }, ms)
}

export function startMonthlySealJob(): void {
  scheduleMonthlyRun()
}
