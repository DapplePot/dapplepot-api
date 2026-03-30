import { Redis } from 'ioredis'
import { env } from '../env.js'

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

redis.on('error', (err) => {
  console.error('[redis] error:', err.message)
})

export async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping()
    return true
  } catch {
    return false
  }
}

export async function closeRedis(): Promise<void> {
  redis.disconnect()
}
