import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  POSTGRES_URL: z.string().url(),
  CLICKHOUSE_HOST: z.string().min(1),
  CLICKHOUSE_PORT: z.coerce.number().default(8443),
  CLICKHOUSE_USER: z.string().default('dapplepot'),
  CLICKHOUSE_PASSWORD: z.string().default('dapplepot'),
  REDIS_URL: z.string().url(),
  SECURITY_SERVICE_URL: z.string().url().default('http://localhost:8001'),
  INTERNAL_API_SECRET: z.string().min(1),
  DAPPLEPOT_JWT_SECRET: z.string().min(1),
  DAPPLEPOT_JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  DAPPLEPOT_JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  DAPPLEPOT_EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend']).default('console'),
  DAPPLEPOT_EMAIL_FROM: z.string().default('noreply@dapplepot.io'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  DAPPLEPOT_APP_URL: z.string().default('http://localhost:5173'),
  API_HOST: z.string().default('0.0.0.0'),
  // Azure App Service injects PORT — fall back to API_PORT then 3000
  API_PORT: z.coerce.number().default(3000),
  PORT: z.coerce.number().optional(),
  API_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  AWS_REGION:        z.string().default('us-east-1'),
  AWS_ENDPOINT_URL:  z.string().url().optional(),
  AUDIT_S3_BUCKET:   z.string().min(1),
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
