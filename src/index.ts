import { serve } from '@hono/node-server'
import { env } from './env.js'
import { closePostgres } from './lib/postgres.js'
import { closeClickHouse } from './lib/clickhouse.js'
import { closeRedis } from './lib/redis.js'
import { closeKafka } from './lib/kafka.js'
import app from './app.js'

serve(
  { fetch: app.fetch, port: env.API_PORT, hostname: env.API_HOST },
  (info) => {
    console.log(`🚀 dapplepot-api listening on http://${info.address}:${info.port}`)
  }
)

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await Promise.all([closePostgres(), closeClickHouse(), closeRedis(), closeKafka()])
  process.exit(0)
})

