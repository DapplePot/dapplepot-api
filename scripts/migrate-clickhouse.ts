import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@clickhouse/client'

const __dirname = dirname(fileURLToPath(import.meta.url))

const chPort = Number(process.env.CLICKHOUSE_PORT ?? 8443)
const chProtocol = chPort === 8443 ? 'https' : 'http'

const clickhouse = createClient({
  url: `${chProtocol}://${process.env.CLICKHOUSE_HOST}:${chPort}`,
  username: process.env.CLICKHOUSE_USER ?? 'dapplepot',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'dapplepot',
})

await clickhouse.command({
  query: `
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   String,
      applied_at DateTime DEFAULT now()
    )
    ENGINE = ReplacingMergeTree()
    ORDER BY filename
  `,
})

// ReplacingMergeTree deduplicates asynchronously, so use FINAL to get a consistent read
const applied = new Set(
  (
    await (
      await clickhouse.query({ query: 'SELECT filename FROM _migrations FINAL', format: 'JSONEachRow' })
    ).json<{ filename: string }>()
  ).map((r) => r.filename)
)

const migrationsDir = join(__dirname, '..', 'db', 'clickhouse')
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file}`)
    continue
  }
  const content = readFileSync(join(migrationsDir, file), 'utf8')
  // Run each statement separately — ClickHouse does not support multi-statement queries
  const statements = content
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const statement of statements) {
    await clickhouse.command({ query: statement })
  }
  await clickhouse.command({
    query: `INSERT INTO _migrations (filename) VALUES ('${file.replace(/'/g, "\\'")}')`,
  })
  console.log(`apply ${file}`)
}

console.log('clickhouse migrations done')
await clickhouse.close()
