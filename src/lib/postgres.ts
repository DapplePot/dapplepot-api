import postgres from 'postgres'
import { env } from '../env.js'

const sql = postgres(env.POSTGRES_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
})

export async function queryRow<T extends Record<string, unknown>>(
  query: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await sql.unsafe(query, params as postgres.ParameterOrFragment<never>[])
  return rows[0] as T | undefined
}

export async function queryRows<T extends Record<string, unknown>>(
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const rows = await sql.unsafe(query, params as postgres.ParameterOrFragment<never>[])
  return rows as T[]
}

export async function queryValue<T>(
  query: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await sql.unsafe(query, params as postgres.ParameterOrFragment<never>[])
  if (!rows[0]) return undefined
  const firstRow = rows[0] as Record<string, unknown>
  const firstKey = Object.keys(firstRow)[0]
  if (!firstKey) return undefined
  return firstRow[firstKey] as T
}

export async function checkPostgres(): Promise<boolean> {
  try {
    await sql`SELECT 1`
    return true
  } catch {
    return false
  }
}

export async function closePostgres(): Promise<void> {
  await sql.end()
}

export { sql }
