import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'

const rows = await sql`
  SELECT kind, COUNT(*)::int AS count FROM tenants GROUP BY kind ORDER BY kind
`
console.log('tenant counts by kind:')
console.log(rows)

const nulls = await sql`SELECT COUNT(*)::int AS count FROM tenants WHERE kind IS NULL`
console.log('null kinds:', nulls[0]?.count)

await sql.end()
