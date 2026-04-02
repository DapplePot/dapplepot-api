import { beforeAll, afterAll } from 'vitest'

beforeAll(async () => {
  // Ensure env vars are set for test environment
  process.env['POSTGRES_URL'] = process.env['POSTGRES_URL'] ?? 'postgresql://dapplepot:dapplepot@localhost:5432/dapplepot_pipeline'
  process.env['CLICKHOUSE_HOST'] = process.env['CLICKHOUSE_HOST'] ?? 'localhost'
  process.env['CLICKHOUSE_PORT'] = process.env['CLICKHOUSE_PORT'] ?? '8123'
  process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
  process.env['KAFKA_BOOTSTRAP_SERVERS'] = process.env['KAFKA_BOOTSTRAP_SERVERS'] ?? 'localhost:9092'
  process.env['DAPPLEPOT_JWT_SECRET'] = process.env['DAPPLEPOT_JWT_SECRET'] ?? 'test-secret'
})

afterAll(async () => {
  // cleanup if needed
})
