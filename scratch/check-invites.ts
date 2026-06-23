import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'

const TARGET = 'pushpendrapal9516@gmail.com'

const rows = await sql`
  SELECT invite_id, tenant_id, email, role, status, created_at, expires_at
  FROM invites WHERE LOWER(email) = LOWER(${TARGET})
  ORDER BY created_at DESC
`
console.log('invites:', rows)
await sql.end()
