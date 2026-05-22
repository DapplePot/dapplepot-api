import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'

async function run() {
  const alerts = await sql`
    select alert_id, rule_name, severity, (payload->>'title') as title, triggered_at 
    from alerts 
    order by triggered_at desc 
    limit 10
  `
  console.log('Latest 10 Alerts:', JSON.stringify(alerts, null, 2))
  await sql.end()
}
run().catch(console.error)




