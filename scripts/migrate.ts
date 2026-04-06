import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import postgres from 'postgres'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ssl = process.env.POSTGRES_SSL === 'true' ? 'require' : false
const sql = postgres(process.env.POSTGRES_URL!, { ssl })

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    id         SERIAL PRIMARY KEY,
    filename   TEXT        NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`

const applied = new Set(
  (await sql`SELECT filename FROM _migrations`).map((r) => r.filename as string)
)

const migrationsDir = join(__dirname, '..', 'migrations')
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file}`)
    continue
  }
  const content = readFileSync(join(migrationsDir, file), 'utf8')
  await sql.begin(async (tx) => {
    await tx.unsafe(content)
    await tx.unsafe('INSERT INTO _migrations (filename) VALUES ($1)', [file])
  })
  console.log(`apply ${file}`)
}

console.log('migrations done')
await sql.end()
