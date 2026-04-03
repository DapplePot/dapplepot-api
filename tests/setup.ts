import { beforeAll, afterAll } from 'vitest'

beforeAll(async () => {
  // Ensure env vars are set for test environment
  process.env['POSTGRES_URL'] = process.env['POSTGRES_URL'] ?? 'postgresql://dapplepot:dapplepot@localhost:5432/dapplepot_pipeline'
  process.env['CLICKHOUSE_HOST'] = process.env['CLICKHOUSE_HOST'] ?? 'localhost'
  process.env['CLICKHOUSE_PORT'] = process.env['CLICKHOUSE_PORT'] ?? '8123'
  process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
  process.env['KAFKA_BOOTSTRAP_SERVERS'] = process.env['KAFKA_BOOTSTRAP_SERVERS'] ?? 'localhost:9092'
  process.env['DAPPLEPOT_JWT_SECRET'] = process.env['DAPPLEPOT_JWT_SECRET'] ?? 'test-secret'
  // Auth system env vars (all have schema defaults, set explicitly for test clarity)
  process.env['DAPPLEPOT_JWT_ACCESS_EXPIRES_IN'] = process.env['DAPPLEPOT_JWT_ACCESS_EXPIRES_IN'] ?? '15m'
  process.env['DAPPLEPOT_JWT_REFRESH_EXPIRES_IN'] = process.env['DAPPLEPOT_JWT_REFRESH_EXPIRES_IN'] ?? '7d'
  process.env['DAPPLEPOT_EMAIL_PROVIDER'] = process.env['DAPPLEPOT_EMAIL_PROVIDER'] ?? 'console'
  process.env['DAPPLEPOT_EMAIL_FROM'] = process.env['DAPPLEPOT_EMAIL_FROM'] ?? 'test@dapplepot.dev'
  process.env['DAPPLEPOT_APP_URL'] = process.env['DAPPLEPOT_APP_URL'] ?? 'http://localhost:5173'
})

afterAll(async () => {
  // cleanup if needed
})
