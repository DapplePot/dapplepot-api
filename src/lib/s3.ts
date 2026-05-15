import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { env } from '../env.js'

export const s3 = new S3Client({
  region: env.AWS_REGION,
  ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL, forcePathStyle: true } : {}),
})

export function auditArchiveKey(tenantId: string, period: string, archiveId: string): string {
  return `audits/${tenantId}/${period}/${archiveId}.json`
}

export async function uploadAuditArchive(key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: env.AUDIT_S3_BUCKET,
    Key:    key,
    Body:   body,
    ContentType:        'application/json',
    ContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
  }))
}

export async function downloadAuditArchive(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({
    Bucket: env.AUDIT_S3_BUCKET,
    Key:    key,
  }))
  if (!res.Body) throw new Error(`Empty S3 response for key ${key}`)
  return res.Body.transformToString()
}
