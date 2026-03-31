import { z } from 'zod'

const envSchema = z.object({
  POSTGRES_URL: z.string().url(),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_DB: z.string().default('dapplepot_pipeline'),
  CLICKHOUSE_USER: z.string().default('dapplepot'),
  CLICKHOUSE_PASSWORD: z.string().default('dapplepot'),
  REDIS_URL: z.string().url(),
  KAFKA_BOOTSTRAP_SERVERS: z.string().default('localhost:9092'),
  DAPPLEPOT_JWT_SECRET: z.string().min(1),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().default(3000),
  API_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  CACHE_TTL_OVERVIEW: z.coerce.number().default(30),
  CACHE_TTL_ANALYTICS: z.coerce.number().default(60),
  CACHE_TTL_COST: z.coerce.number().default(300),
  CACHE_TTL_SECURITY_OVERVIEW: z.coerce.number().default(120),
  CACHE_TTL_SESSION_SCORE: z.coerce.number().default(300),
  CACHE_TTL_REMEDIATION: z.coerce.number().default(300),
})

function parseEnv() {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('❌ Invalid environment variables:')
    console.error(result.error.flatten().fieldErrors)
    process.exit(1)
  }
  return result.data
}

export const env = parseEnv()
export type Env = typeof env
