import { cors } from 'hono/cors'
import { env } from '../env.js'

// API_CORS_ORIGIN is a comma-separated list so the dashboard (app.*) and the
// marketing site (www.*) can both be allowed without loosening CORS to '*'.
const allowedOrigins = env.API_CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

export const corsMiddleware = cors({
  origin: allowedOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  exposeHeaders: ['X-Total-Count'],
  credentials: true,
})
