import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'

const r = await sql`
  UPDATE tenants
  SET name = regexp_replace(name, ' \\[[0-9a-f]{6}\\]$', '')
  WHERE kind = 'personal' AND name ~ ' \\[[0-9a-f]{6}\\]$'
  RETURNING tenant_id, name
`
console.log('updated:', r)
await sql.end()
