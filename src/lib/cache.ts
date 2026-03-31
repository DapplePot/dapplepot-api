import { redis } from './redis.js'
import { env } from '../env.js'

export const CACHE_TTL_SECURITY_OVERVIEW  = env.CACHE_TTL_SECURITY_OVERVIEW
export const CACHE_TTL_SESSION_SCORE      = env.CACHE_TTL_SESSION_SCORE
export const CACHE_TTL_REMEDIATION        = env.CACHE_TTL_REMEDIATION

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
