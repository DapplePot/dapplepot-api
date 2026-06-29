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
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  DAPPLEPOT_APP_URL: z.string().default('http://localhost:5173'),
  API_HOST: z.string().default('0.0.0.0'),
  // Azure App Service injects PORT — fall back to API_PORT then 3000
  API_PORT: z.coerce.number().default(3000),
  PORT: z.coerce.number().optional(),
  API_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  CACHE_TTL_OVERVIEW: z.coerce.number().default(30),
  CACHE_TTL_ANALYTICS: z.coerce.number().default(60),
  CACHE_TTL_COST: z.coerce.number().default(300),
  CACHE_TTL_SECURITY_OVERVIEW: z.coerce.number().default(120),
  CACHE_TTL_SESSION_SCORE: z.coerce.number().default(300),
  CACHE_TTL_REMEDIATION: z.coerce.number().default(300),
  // Public bucket — blog and marketing media (served via public URL).
  GCS_BLOG_BUCKET: z.string().default('dapplepot-blogs'),
  // Private bucket — sealed audit archives. Never world-readable.
  GCS_APP_BUCKET: z.string().default('dapplepot-app'),
  GCS_PROJECT_ID: z.string().optional(),
  GCS_CLIENT_EMAIL: z.string().optional(),
  GCS_PRIVATE_KEY: z.string().optional(),
  // ── Lemon Squeezy (Phase 8) ─────────────────────────────────────────────
  // All LS vars are optional so the app boots in dev without LS configured.
  // Routes that need them check at request time and return a 503 if missing.
  // Get values from https://app.lemonsqueezy.com/settings/api after creating
  // your store. Variant IDs are numeric strings ("123456") from each product
  // page (Products → Variants tab).
  LEMONSQUEEZY_API_KEY:               z.string().optional(),
  LEMONSQUEEZY_STORE_ID:              z.string().optional(),
  LEMONSQUEEZY_WEBHOOK_SECRET:        z.string().optional(),
  LEMONSQUEEZY_VARIANT_PRO_MONTHLY:   z.string().optional(),
  LEMONSQUEEZY_VARIANT_PRO_ANNUAL:    z.string().optional(),
  LEMONSQUEEZY_VARIANT_TEAM_MONTHLY:  z.string().optional(),
  LEMONSQUEEZY_VARIANT_TEAM_ANNUAL:   z.string().optional(),
  // ── Google OAuth (optional) ─────────────────────────────────────────────
  // Set all three to enable "Continue with Google" on Login / Signup /
  // Accept invite. Leaving any unset disables the route (it 404s) and the
  // UI hides the button.
  GOOGLE_CLIENT_ID:     z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI:  z.string().url().optional(),
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
