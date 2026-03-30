import { createClient } from '@clickhouse/client'
import { env } from '../env.js'

export const clickhouse = createClient({
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DB,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: {
    output_format_json_quote_64bit_integers: 0,
  },
})

export async function chQuery<T extends Record<string, unknown>>(
  query: string,
  params?: Record<string, unknown>
): Promise<T[]> {
  const result = await clickhouse.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  })
  return result.json<T>()
}

export async function chQueryRow<T extends Record<string, unknown>>(
  query: string,
  params?: Record<string, unknown>
): Promise<T | undefined> {
  const rows = await chQuery<T>(query, params)
  return rows[0]
}

export async function checkClickHouse(): Promise<boolean> {
  try {
    await clickhouse.ping()
    return true
  } catch {
    return false
  }
}

export async function closeClickHouse(): Promise<void> {
  await clickhouse.close()
}
