import { createClient } from '@clickhouse/client'
import { env } from '../env.js'

const chProtocol = env.CLICKHOUSE_PORT === 8443 ? 'https' : 'http'

export const clickhouse = createClient({
  url: `${chProtocol}://${env.CLICKHOUSE_HOST}:${env.CLICKHOUSE_PORT}`,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
  clickhouse_settings: {
    output_format_json_quote_64bit_integers: 0,
    date_time_input_format: 'best_effort',
  },
})

export async function chQuery<T extends Record<string, unknown>>(
  query: string,
  params?: Record<string, unknown>
): Promise<T[]> {
  try {
    const result = await clickhouse.query({
      query,
      ...(params !== undefined ? { query_params: params } : {}),
      format: 'JSONEachRow',
    })
    return result.json<T>()
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause
    if (cause) console.error('[clickhouse] underlying error:', cause)
    throw err
  }
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
