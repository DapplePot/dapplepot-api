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

/**
 * Uploads a file buffer to Google Cloud Storage under the landing-website/blogs/ folder.
 * Returns the public URL of the uploaded asset.
 */
export async function uploadToGCS(
  filename: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const bucketName = env.GCS_BUCKET
  const destination = `landing-website/blogs/${filename}`

  if (storage) {
    const bucket = storage.bucket(bucketName)
    const file = bucket.file(destination)
    await file.save(buffer, {
      metadata: {
        contentType: contentType,
      },
      resumable: false,
    })
    return `https://storage.googleapis.com/${bucketName}/${destination}`
  } else {
    console.warn('⚠️ GCS credentials not configured. Returning data URL for local preview.')
    const base64 = buffer.toString('base64')
    return `data:${contentType};base64,${base64}`
  }
}

