import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'

const TARGET = 'pushpendrapal9516@gmail.com'

const rows = await sql`
  DELETE FROM invites WHERE LOWER(email) = LOWER(${TARGET})
  RETURNING invite_id, status
`
console.log('deleted invites:', rows)
await sql.end()
