/**
 * Daily cron: physically delete tenants in lifecycle_state='deleted'.
 *
 * Run: pnpm tsx scripts/delete_expired_tenants.ts
 * Schedule once per day at 01:00 UTC (after lifecycle_transitions @ 00:30).
 *
 * Deletion order:
 *   1. ClickHouse rows (obs_events) for the tenant
 *   2. GCS audit archives for the tenant (deleted from GCS_APP_BUCKET)
 *   3. Postgres tenant row — CASCADE removes:
 *        agents, channels, sessions, alerts, billing_periods,
 *        subscriptions, upgrade_requests, nudge_dispatch_log,
 *        tenant_members, audit_archives metadata
 *   4. Users with no remaining tenant_members rows are also deleted
 *
 * Idempotent: deletion is the final state, so re-running picks up any
 * newly-promoted tenants and is a no-op for already-deleted ones.
 *
 * SAFETY: This is destructive. The script logs every tenant + record
 * count it deletes. Run with DRY_RUN=1 to preview without deleting.
 */

import 'dotenv/config'
import postgres from 'postgres'
import { createClient } from '@clickhouse/client'
import { Storage } from '@google-cloud/storage'

const DRY_RUN = process.env.DRY_RUN === '1'
if (DRY_RUN) console.log('🟡 DRY RUN — no destructive operations will be performed')

function buildGcs(): Storage | null {
    const projectId = process.env.GCS_PROJECT_ID
    const email     = process.env.GCS_CLIENT_EMAIL
    const key       = process.env.GCS_PRIVATE_KEY
    if (!projectId || !email || !key) return null
    return new Storage({
        projectId,
        credentials: { client_email: email, private_key: key.replace(/\\n/g, '\n') },
    })
}

async function main(): Promise<void> {
    const ssl = process.env.POSTGRES_SSL === 'true' ? 'require' : false
    const sql = postgres(process.env.POSTGRES_URL!, { ssl })

    const ch = createClient({
        url:      `${process.env.CLICKHOUSE_PORT === '8443' ? 'https' : 'http'}://${process.env.CLICKHOUSE_HOST}:${process.env.CLICKHOUSE_PORT ?? 8123}`,
        username: process.env.CLICKHOUSE_USER ?? 'dapplepot',
        password: process.env.CLICKHOUSE_PASSWORD ?? '',
    })

    const gcs         = buildGcs()
    const auditBucket = process.env.GCS_APP_BUCKET

    try {
        const targets = await sql<{ tenant_id: string; name: string }[]>`
            SELECT tenant_id, name FROM tenants WHERE lifecycle_state = 'deleted'
        `

        if (targets.length === 0) {
            console.log('No tenants to delete.')
            return
        }

        console.log(`Found ${targets.length} tenant(s) marked for deletion.`)

        for (const t of targets) {
            console.log(`\n→ ${t.name} (${t.tenant_id})`)

            // 1. ClickHouse — delete all observability events for this tenant
            const chRes = await ch.query({
                query: `SELECT count() AS n FROM obs_events WHERE tenant_id = {tenantId:String}`,
                query_params: { tenantId: t.tenant_id },
                format: 'JSONEachRow',
            })
            const [chRow] = await chRes.json<{ n: string }>()
            console.log(`    ClickHouse rows: ${chRow?.n ?? 0}`)
            if (!DRY_RUN) {
                await ch.command({
                    query: `ALTER TABLE obs_events DELETE WHERE tenant_id = {tenantId:String}`,
                    query_params: { tenantId: t.tenant_id },
                })
            }

            // 2. GCS audit archives — list + delete every object under the tenant prefix
            if (gcs && auditBucket) {
                const prefix   = `audit-archives/${t.tenant_id}/`
                const bucket   = gcs.bucket(auditBucket)
                const [files]  = await bucket.getFiles({ prefix })
                if (files.length > 0 && !DRY_RUN) {
                    await Promise.all(files.map(f => f.delete({ ignoreNotFound: true })))
                }
                console.log(`    GCS objects:     ${files.length}`)
            }

            // 3. Postgres — CASCADE wipes children. Users with no remaining
            // workspaces get cleaned up after, via a separate query.
            if (!DRY_RUN) {
                await sql`DELETE FROM tenants WHERE tenant_id = ${t.tenant_id}`
            }
            console.log(`    Postgres tenant row deleted (CASCADE).`)
        }

        // 4. Orphan-user cleanup — users with no tenant_members rows
        if (!DRY_RUN) {
            const orphaned = await sql<{ user_id: string }[]>`
                DELETE FROM users u
                WHERE NOT EXISTS (
                    SELECT 1 FROM tenant_members tm WHERE tm.user_id = u.user_id
                )
                AND u.role != 'superadmin'
                RETURNING user_id
            `
            console.log(`\nOrphan users cleaned up: ${orphaned.length}`)
        }
    } finally {
        await sql.end()
        await ch.close()
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('delete_expired_tenants failed:', err); process.exit(1) })
