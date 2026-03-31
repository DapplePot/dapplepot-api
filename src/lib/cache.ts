import { redis } from './redis.js'

// Security scores are stable once written (scorer runs once post-session)
// Re-scoring on scorer update would replace the row, which invalidates automatically
export const CACHE_TTL_SECURITY_OVERVIEW  = 120   // 2 minutes
export const CACHE_TTL_SESSION_SCORE      = 300   // 5 minutes — stable once written
export const CACHE_TTL_REMEDIATION        = 300   // 5 minutes

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>
): Promise<T> {
  const hit = await redis.get(key)
  if (hit) return JSON.parse(hit) as T
  const value = await fetch()
  await redis.setex(key, ttlSeconds, JSON.stringify(value))
  return value
}

export async function invalidate(key: string): Promise<void> {
  await redis.del(key)
}
