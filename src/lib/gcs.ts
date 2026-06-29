import { Storage } from '@google-cloud/storage'
import { env } from '../env.js'

let storage: Storage | null = null

if (env.GCS_PROJECT_ID && env.GCS_CLIENT_EMAIL && env.GCS_PRIVATE_KEY) {
  const privateKey = env.GCS_PRIVATE_KEY.replace(/\\n/g, '\n')
  storage = new Storage({
    projectId: env.GCS_PROJECT_ID,
    credentials: {
      client_email: env.GCS_CLIENT_EMAIL,
      private_key: privateKey,
    },
  })
}

/** True when GCS credentials are configured. */
export function isGcsConfigured(): boolean {
  return storage !== null
}

/** Internal — returns the live Storage client or throws if unconfigured. */
function requireStorage(): Storage {
  if (!storage) {
    throw new Error(
      'GCS is not configured. Set GCS_PROJECT_ID, GCS_CLIENT_EMAIL, and GCS_PRIVATE_KEY.'
    )
  }
  return storage
}

// ── Blog media (public bucket: GCS_BLOG_BUCKET) ──────────────────────────────

/**
 * Uploads a file buffer to the public blog bucket under landing-website/blogs/.
 * Returns the public URL of the uploaded asset.
 */
export async function uploadToGCS(
  filename: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const bucketName  = env.GCS_BLOG_BUCKET
  const destination = `landing-website/blogs/${filename}`

  if (storage) {
    const bucket = storage.bucket(bucketName)
    const file   = bucket.file(destination)
    await file.save(buffer, {
      metadata:  { contentType },
      resumable: false,
    })
    return `https://storage.googleapis.com/${bucketName}/${destination}`
  } else {
    console.warn('⚠️ GCS credentials not configured. Returning data URL for local preview.')
    const base64 = buffer.toString('base64')
    return `data:${contentType};base64,${base64}`
  }
}

// ── Audit archives (private bucket: GCS_APP_BUCKET) ──────────────────────────

/** Object path inside GCS_APP_BUCKET for a sealed audit archive. */
export function auditArchiveKey(tenantId: string, period: string, archiveId: string): string {
  return `audit-archives/${tenantId}/${period}/${archiveId}.json`
}

/** Prefix used to list/delete every audit archive for a tenant. */
export function auditArchiveTenantPrefix(tenantId: string): string {
  return `audit-archives/${tenantId}/`
}

/** Upload a sealed audit archive (JSON) to the private app bucket. */
export async function uploadAuditArchive(key: string, body: string): Promise<void> {
  const bucket = requireStorage().bucket(env.GCS_APP_BUCKET)
  await bucket.file(key).save(body, {
    metadata: {
      contentType:        'application/json',
      contentDisposition: `attachment; filename="${key.split('/').pop()}"`,
    },
    resumable: false,
  })
}

/** Download a sealed audit archive (JSON) from the private app bucket. */
export async function downloadAuditArchive(key: string): Promise<string> {
  const bucket = requireStorage().bucket(env.GCS_APP_BUCKET)
  const [contents] = await bucket.file(key).download()
  return contents.toString('utf8')
}

/**
 * Delete every audit archive under a tenant's prefix. Used by the
 * delete_expired_tenants cron.
 *
 * Returns the number of objects deleted.
 */
export async function deleteTenantAuditArchives(tenantId: string): Promise<number> {
  const bucket = requireStorage().bucket(env.GCS_APP_BUCKET)
  const prefix = auditArchiveTenantPrefix(tenantId)
  const [files] = await bucket.getFiles({ prefix })

  if (files.length === 0) return 0

  // Bulk delete — runs sequentially per file but is fine at audit volumes.
  await Promise.all(files.map(f => f.delete({ ignoreNotFound: true })))
  return files.length
}
